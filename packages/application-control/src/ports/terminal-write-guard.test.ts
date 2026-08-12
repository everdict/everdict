import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ── THE STRUCTURAL HALF OF "FIRST TERMINAL WRITE WINS" ───────────────────────────────────────────────
//
// The rule has one shape and four reviews found it broken in a different place each time: a writer settles a
// run by reading it, asking the domain whether it is already terminal, and writing — which is a TOCTOU
// whenever the competing writer is in another process, and for these paths it always is (a cancel against a
// case drain, a boot recovery against a dying worker, an orphan sweep against a lane that just finished).
//
// The condition exists (`expectNonTerminal`, evaluated in SQL) and is optional, so obeying it is call-site
// discipline — and a forgotten guard does not fail visibly. It silently makes the LAST write win, which is
// the exact inverse of the rule, in the one direction nobody notices until a cancelled batch's child is
// recorded as succeeded.
//
// THE VERB NOW EXISTS, so the guard has two jobs rather than one. `settleRun` / `settleScorecard`
// (`ports/settle.ts`) take the fence as a PARAMETER, which is the only version of this rule a caller cannot
// forget — there is nothing to leave out. A settlement therefore does not go through `update` at all, and
// this scan is what says so: writing one the old way fails here, whether or not it remembered the condition.
//
// The weaker rule stays for everything else. Non-terminal lifecycle transitions (start, redispatch, extend)
// are still `update` calls — they are claims about the row's current state, and a claim that does not travel
// with its condition is the same read-check-write, so they must carry the guard by hand.
//
// GETTING ON THE ALLOWLIST means the write is not a settlement — it patches metadata, or it is the fake in a
// test double. It never means "this one is fine without the CAS".
const ALLOWED = new Set<string>([
  // The store ports/impls themselves: they DEFINE the guard rather than call it.
  "packages/application-control/src/ports/run-store.ts",
  "packages/application-control/src/ports/scorecard-store.ts",
  // …and the verb, which is the one place a settlement is allowed to reach `update` — it is what everything
  // else calls INSTEAD of reaching it.
  "packages/application-control/src/ports/settle.ts",
]);

// WHERE THE RULE APPLIES: everywhere the product is written, not one package. A helper is not an invariant —
// arch-review 31's P0 was a raw, unfenced terminal write in `apps/api`'s composition root, which this scan
// walked past because it only ever looked inside `application-control`. Any layer that can reach a store can
// reach `update`, so any layer that can reach a store is scanned.
//
// `packages/db` is excluded rather than allowlisted: it IMPLEMENTS the guard (that is where `expectNonTerminal`
// becomes SQL), and asking the implementation to call the verb it provides is circular.
const SCAN_ROOTS = ["apps", "packages"];
const EXCLUDED_ROOTS = new Set(["packages/db", "packages/domain"]);

// A LIFECYCLE WRITE, by the two shapes one takes: a literal status, or — far more common here, and the shape
// that made a literal-only scanner useless — a patch produced by a DOMAIN TRANSITION (`.patch`). Every one of
// the settlements four reviews found unfenced was written the second way, so a guard that only saw literals
// would have caught none of them.
//
// The rule covers non-terminal transitions too, and that is deliberate rather than collateral: starting or
// adopting a run that another process has already settled is the same read-check-write, with the same last
// writer winning. A transition is a claim about the run's current state; the CAS is what makes it one.
// A LIFECYCLE WRITE, by the two shapes one takes.
//
// ① A patch produced by a DOMAIN TRANSITION (`.patch`). This is the shape that matters most and the one a
//    literal-only scanner would miss entirely — every settlement the reviews found unfenced was written this
//    way. It is scanned for BOTH aggregates: the run lifecycle got its fence one review at a time and the
//    BATCH that owns those runs never did, which is exactly the gap a scanner scoped to one of them keeps.
//
// ② A literal status. Narrower, because a nested marker's status is not the aggregate's — a scoring pass
//    writes `scoringPass: { status: "failed" }` under its OWN fence, and demanding a lifecycle guard there
//    would be the scanner asking for the wrong condition.
const TRANSITION_WRITE = /\.patch\b/;
const LITERAL_STATUS = /status:\s*"(succeeded|failed|suspended|superseded|cancelled)"/;
const NESTED_MARKER = /scoringPass\s*:/;
// WHAT COUNTS AS FENCED. `expectNonTerminal` is the ordinary settle's condition; `expectStatusIn` is the
// narrower one an aborted settle needs (it lands on a cancelled record on purpose); and a re-scoring pass
// settles an ALREADY-terminal batch under the scoring plane's own authority — demanding a lifecycle guard
// there would be asking for a condition that contradicts the transition.
const CAS = /expectNonTerminal|expectStatusIn|expectScoringCount|expectScoringPassId/;
// WHOSE lifecycle this is. Only two aggregates have a terminal fence — the run and the batch that owns those
// runs — so only they are scanned: a tracker record's `.patch` write is an ordinary edit, and demanding a
// settle guard there would be the scanner asking for a condition that does not exist.
//
// QUALIFIED BY THE AGGREGATE, NOT BY THE PLUMBING. Twice now this scan has gone green over a file it believed
// it was watching: first because the receiver's type was declared one file away, then because the deps type
// it named (`ScorecardServiceDeps`) is not the one the batch service imports (`ScorecardBatchDeps`). Both
// times the marker was a wiring detail, and wiring details are exactly what a refactor renames.
//
// `Run.from(` / `ScorecardBatch.from(` is not a wiring detail. A file that constructs one of these aggregates
// is driving that lifecycle, whatever it calls the store it writes through — and a file that stops
// constructing them has stopped driving it.
const DRIVES_LIFECYCLE = /\b(Run|ScorecardBatch)\.from\(/;
// A SETTLEMENT, as opposed to a lifecycle write in general: the patch comes from a transition that ENDS the
// aggregate, or it names a terminal status outright. These are the writes the verb exists for, so finding one
// inside an `update(` span is a failure regardless of what guard it carries — the condition being present
// this time is not the property being defended; being impossible to omit is.
//
// WHICH TRANSITIONS END AN AGGREGATE IS THE DOMAIN'S ANSWER, NOT A LIST KEPT HERE. The first version spelled
// the names out (`fail`, `cancel`, `supersede`, …) and was already wrong when it was written: `Run.adopt()`
// returns `status: "succeeded"` — as terminal as a transition gets — and was missing, so the documentation
// filed it under "ordinary lifecycle write" and this scan agreed. A hand-kept list of another module's method
// names is a copy that drifts by default; the next terminal transition somebody adds is missing from it for
// exactly as long as nobody remembers.
//
// So the list is READ from the domain: any method whose body produces a terminal status. Add a transition
// that ends a run tomorrow and it is covered the moment it exists, with nothing to remember.
function settlingMethodsOf(files: string[]): string[] {
  const names = new Set<string>(["settle"]); // the `settle(current)` callback shape the batch passes down
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    // `<name>(…) {` … up to the next same-indent method — the body a terminal status would appear in.
    for (const m of text.matchAll(/\n {2}(?:async )?(\w+)\(([^)]*)\)[^{]*\{([\s\S]*?)\n {2}\}/g)) {
      const [, name, , body] = m;
      if (name !== undefined && body !== undefined && producesSettlement(body)) names.add(name);
    }
    // …and the free functions the aggregates delegate to (`settleAgentTransition`, `closeSessionTransition`).
    for (const m of text.matchAll(/export function (\w+)\(([\s\S]*?)\n\}/g)) {
      const [, name, body] = m;
      if (name !== undefined && body !== undefined && producesSettlement(body)) names.add(name);
    }
  }
  return [...names];
}
// PRODUCES one, rather than mentions one: `terminalRunFacts` and the legality assertions name these statuses
// constantly and settle nothing. What makes a transition a settlement is that it hands back a PATCH carrying
// the terminal status.
const producesSettlement = (body: string): boolean =>
  /status:\s*"(succeeded|failed|suspended|superseded|cancelled)"/.test(body) && /patch:\s*\{/.test(body);
// The verb itself. Counted so the scan cannot go green by matching nothing at all.
const SETTLE_VERB = /\b(settleRun|settleScorecard)\(/;
// A write that NAMES a terminal status is a settlement wherever it appears — no file-level qualifier, because
// the file that carried arch-review 31's P0 never constructs an aggregate at all. It is a composition root
// that reaches a store directly, which is precisely the layer a package-scoped scan cannot see.
const isLiteralSettlement = (span: string): boolean => LITERAL_STATUS.test(span) && !NESTED_MARKER.test(span);

function tsFilesUnder(dir: string, prefix = ""): string[] {
  if (EXCLUDED_ROOTS.has(prefix) || prefix.endsWith("/dist") || prefix.endsWith("/node_modules")) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(full).isDirectory()) return tsFilesUnder(full, rel);
    if (!name.endsWith(".ts") || name.endsWith(".test.ts")) return [];
    return [rel];
  });
}

// Comment text is not code: a file that only DISCUSSES a terminal status must not trip the scanner (this
// codebase's comments discuss them constantly, on purpose).
function codeOf(text: string): string {
  return text
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .map((line) => line.replace(/\s+\/\/.*$/, ""))
    .join("\n");
}

// Each `…update(` call's own ARGUMENT SPAN, by balancing parentheses. The receiver is matched by SHAPE — any
// `…store` / `…Store`, plus the two collection names these are held under — rather than by the four
// identifiers that happened to exist when this was written: a rule that only recognises today's variable
// names is a rule the next rename repeals.
// File-level co-occurrence is not the
// question — a service that filters a query by `status: "succeeded"` somewhere else in the file is not
// settling a run, and a guard that cannot tell those apart teaches people to add allowlist entries until it
// means nothing.
function updateCalls(code: string): Array<{ span: string; context: string }> {
  const spans: Array<{ span: string; context: string }> = [];
  for (const match of code.matchAll(/\b(?:runs|scorecards|\w*[Ss]tore)\.update\(/g)) {
    let depth = 0;
    let i = (match.index ?? 0) + match[0].length - 1;
    const start = i;
    for (; i < code.length; i++) {
      if (code[i] === "(") depth += 1;
      else if (code[i] === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    spans.push({ span: code.slice(start, i + 1), context: enclosingBody(code, start) + code.slice(start, i + 1) });
  }
  return spans;
}

// THE TRANSITION IS NOT IN THE ARGUMENT LIST. Almost every writer here builds its patch a few lines earlier
// (`const transition = run.closeSession(…)`) and passes `transition.patch`, so a span-local test for a settle
// verb sees nothing and calls a settlement ordinary. The first draft of this rule went green over exactly
// that, which is the failure mode a structural guard is supposed to be immune to.
//
// So the question is asked of the ENCLOSING FUNCTION instead — from its declaration down to the write. That
// is the unit in which one of these is authored, and widening further (the whole file) would let a settle in
// the method above answer for the method below.
const KEYWORD = /^(if|for|while|switch|catch|return|await|typeof|new|throw|else|do)$/;

function enclosingBody(code: string, at: number): string {
  const before = code.slice(0, at);
  let start = 0;
  // A FUNCTION header, not any declaration: at most two spaces of indent (a top-level function or a class
  // method). The first version accepted `const` at any indent and so stopped at the write's own line — which
  // is how it went green over a settlement it was pointed straight at.
  // A declaration at ≤2 spaces of indent: a top-level function or a class method. Spelled as "a name
  // followed by an argument list", because a class method wears no keyword at all (`  async submit(`) — an
  // earlier version listed keywords, missed exactly those, and walked back to whatever method came before.
  for (const header of before.matchAll(
    /\n {0,2}(?:export |private |protected |public |static |async )*([\w$]+)\s*[(<]/g,
  )) {
    if (KEYWORD.test(header[1] ?? "")) continue; // `if (`, `for (`, `switch (` — control flow, not a declaration
    start = header.index ?? 0;
  }
  return before.slice(start);
}

describe("terminal-write guard — a settlement carries its CAS", () => {
  const root = join(__dirname, "../../../..");
  // The domain modules that OWN the two lifecycles. What they call their terminal transitions is their
  // business; that this scan knows all of them is the property being kept.
  const domainDir = join(root, "packages/domain/src");
  const SETTLING = settlingMethodsOf(
    ["run/run.ts", "run/agent-run.ts", "run/session-run.ts", "run/command-run.ts", "scorecard/scorecard-batch.ts"]
      .map((rel) => join(domainDir, rel))
      .filter((f) => existsSync(f)),
  );
  const SETTLE_TRANSITION = new RegExp(`\\.(?:${SETTLING.join("|")})\\(|\\bsettle\\(`);
  const scanned = SCAN_ROOTS.flatMap((r) => tsFilesUnder(join(root, r), r)).filter((rel) => !ALLOWED.has(rel));
  const files = scanned.map((rel) => ({ rel, code: codeOf(readFileSync(join(root, rel), "utf8")) }));
  const lifecycleWrites = files.flatMap(({ rel, code }) => {
    const drives = DRIVES_LIFECYCLE.test(code);
    return updateCalls(code)
      .filter(({ span }) => (drives && TRANSITION_WRITE.test(span)) || isLiteralSettlement(span))
      .map((call) => ({ rel, ...call }));
  });
  // WHOSE TRANSITION THIS WRITE CARRIES. When the span names it inline — `run.redispatch(now).patch` — that
  // name IS the answer, and the enclosing function must not be consulted: `resume` settles an adoption AND
  // re-dispatches, so a function-wide question marks the re-dispatch a settlement and demands the verb for a
  // write that ends nothing. Only when the patch arrives as a bare variable (`transition.patch`, built a few
  // lines up) does the enclosing function get asked.
  const isSettlement = ({ span, context }: { span: string; context: string }): boolean => {
    if (isLiteralSettlement(span)) return true;
    const inline = /\.(\w+)\([^;]*?\)\.patch/.exec(span);
    if (inline) return SETTLING.includes(inline[1] ?? "");
    return SETTLE_TRANSITION.test(context);
  };

  it("a settlement goes through the settle verb, never through `update`", () => {
    expect(lifecycleWrites.filter(isSettlement).map(({ rel }) => rel)).toEqual([]);
  });

  it("every other lifecycle write through `update` carries the guard by hand", () => {
    expect(lifecycleWrites.filter(({ span }) => !CAS.test(span)).map(({ rel }) => rel)).toEqual([]);
  });

  it("the scanner still matches the writers it is meant to watch", () => {
    // A guard that silently stops matching is worse than no guard: it reports green forever. If a rename
    // moves the settle paths out of this package, this fails and someone has to point it at the new home
    // rather than deleting it. Both halves are counted: the verb's callers AND the `update` writes the
    // second rule polices, because either one going quiet hides a different half of the invariant.
    expect(files.filter(({ code }) => SETTLE_VERB.test(code)).length).toBeGreaterThan(4);
    expect(lifecycleWrites.length).toBeGreaterThan(0);
    // …and it is looking at the WHOLE product. A glob that quietly stops leaving `application-control` is how
    // the composition-root defect survived a scan that was, by its own report, green.
    expect(scanned.some((rel) => rel.startsWith("apps/api/"))).toBe(true);
    // …and it read the domain's own taxonomy rather than a list somebody typed here. `adopt` is the proof
    // that matters: it settles a run `succeeded` and every hand-written list of these names had missed it.
    expect(SETTLING).toContain("adopt");
    expect(SETTLING).toContain("fail");
    expect(SETTLING.length).toBeGreaterThan(5);
  });
});
