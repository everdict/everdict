import { readFileSync, readdirSync, statSync } from "node:fs";
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
// The weaker rule stays for everything else. Non-terminal lifecycle transitions (start, adopt, redispatch,
// extend) are still `update` calls — they are claims about the row's current state, and a claim that does not
// travel with its condition is the same read-check-write, so they must carry the guard by hand.
//
// GETTING ON THE ALLOWLIST means the write is not a settlement — it patches metadata, or it is the fake in a
// test double. It never means "this one is fine without the CAS".
const ALLOWED = new Set<string>([
  // The RunStore ports/impls themselves: they DEFINE the guard rather than call it.
  "ports/run-store.ts",
  // …and the verb, which is the one place a settlement is allowed to reach `update` — it is what the rest of
  // the package calls INSTEAD of reaching it.
  "ports/settle.ts",
]);

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
const SETTLE_TRANSITION = /\.(settleAgent|settleAborted|settle|fail|cancel|supersede|closeSession)\(|\bsettle\(/;
// The verb itself. Counted so the scan cannot go green by matching nothing at all.
const SETTLE_VERB = /\b(settleRun|settleScorecard)\(/;

function tsFilesUnder(dir: string, prefix = ""): string[] {
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

// Each `…update(` call's own ARGUMENT SPAN, by balancing parentheses. File-level co-occurrence is not the
// question — a service that filters a query by `status: "succeeded"` somewhere else in the file is not
// settling a run, and a guard that cannot tell those apart teaches people to add allowlist entries until it
// means nothing.
function updateCalls(code: string): Array<{ span: string; context: string }> {
  const spans: Array<{ span: string; context: string }> = [];
  for (const match of code.matchAll(/\b(?:runs|runStore|scorecards|store)\.update\(/g)) {
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
function enclosingBody(code: string, at: number): string {
  const before = code.slice(0, at);
  let start = 0;
  // A FUNCTION header, not any declaration: at most two spaces of indent (a top-level function or a class
  // method). The first version accepted `const` at any indent and so stopped at the write's own line — which
  // is how it went green over a settlement it was pointed straight at.
  for (const header of before.matchAll(
    /\n {0,2}(?:private |protected |public |export |async function |function |const \w+ = )/g,
  )) {
    start = header.index ?? 0;
  }
  return before.slice(start);
}

describe("terminal-write guard — a settlement carries its CAS", () => {
  const root = join(__dirname, "..");
  const scanned = tsFilesUnder(root).filter((rel) => !ALLOWED.has(rel));
  const files = scanned.map((rel) => ({ rel, code: codeOf(readFileSync(join(root, rel), "utf8")) }));
  const lifecycleWrites = files.flatMap(({ rel, code }) => {
    if (!DRIVES_LIFECYCLE.test(code)) return [];
    return updateCalls(code)
      .filter(({ span }) => TRANSITION_WRITE.test(span) || (LITERAL_STATUS.test(span) && !NESTED_MARKER.test(span)))
      .map((call) => ({ rel, ...call }));
  });
  const isSettlement = ({ span, context }: { span: string; context: string }): boolean =>
    SETTLE_TRANSITION.test(context) || (LITERAL_STATUS.test(span) && !NESTED_MARKER.test(span));

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
  });
});
