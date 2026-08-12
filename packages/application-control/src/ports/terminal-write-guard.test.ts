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
// TypeScript cannot express "this patch settles a run, so it needs the CAS" without a discriminated
// transition type the domain does not have yet (`RunStore.settle()` is the eventual shape — the review that
// asked for it is right, and it is a deeper refactor than a guard). Until then this stands in: a file that
// writes a terminal status through `update` must carry the guard, and a new writer that forgets fails here
// rather than in production.
//
// GETTING ON THE ALLOWLIST means the write is not a settlement — it patches metadata, or it is the fake in a
// test double. It never means "this one is fine without the CAS".
const ALLOWED = new Set<string>([
  // The RunStore ports/impls themselves: they DEFINE the guard rather than call it.
  "ports/run-store.ts",
]);

// A LIFECYCLE WRITE, by the two shapes one takes: a literal status, or — far more common here, and the shape
// that made a literal-only scanner useless — a patch produced by a DOMAIN TRANSITION (`.patch`). Every one of
// the settlements four reviews found unfenced was written the second way, so a guard that only saw literals
// would have caught none of them.
//
// The rule covers non-terminal transitions too, and that is deliberate rather than collateral: starting or
// adopting a run that another process has already settled is the same read-check-write, with the same last
// writer winning. A transition is a claim about the run's current state; the CAS is what makes it one.
const LIFECYCLE_WRITE = /status:\s*"(succeeded|failed|suspended)"|\.patch\b/;
const CAS = /expectNonTerminal/;
// WHOSE `update` is a run's. `runs`/`runStore` name themselves; a bare `store` is only a RunStore in a module
// that says so in its own deps type — in a scorecard service `store.update` writes a scorecard, and a scanner
// that could not tell the two apart would demand a run guard on a scoring-pass write.
const RUN_STORE_RECEIVER = /\bstore\s*:\s*RunStore\b/;

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
function updateCalls(code: string): string[] {
  const spans: string[] = [];
  const receiver = RUN_STORE_RECEIVER.test(code)
    ? /\b(?:runs|runStore|store)\.update\(/g
    : /\b(?:runs|runStore)\.update\(/g;
  for (const match of code.matchAll(receiver)) {
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
    spans.push(code.slice(start, i + 1));
  }
  return spans;
}

describe("terminal-write guard — a settlement carries its CAS", () => {
  const root = join(__dirname, "..");
  const scanned = tsFilesUnder(root).filter((rel) => !ALLOWED.has(rel));
  const settlements = scanned.flatMap((rel) =>
    updateCalls(codeOf(readFileSync(join(root, rel), "utf8")))
      .filter((span) => LIFECYCLE_WRITE.test(span))
      .map((span) => ({ rel, span })),
  );

  it("every settlement written through `update` passes expectNonTerminal", () => {
    expect(settlements.filter(({ span }) => !CAS.test(span)).map(({ rel }) => rel)).toEqual([]);
  });

  it("the scanner still matches the writers it is meant to watch", () => {
    // A guard that silently stops matching is worse than no guard: it reports green forever. If a rename
    // moves the settle paths out of this package, this fails and someone has to point it at the new home
    // rather than deleting it.
    expect(settlements.length).toBeGreaterThan(0);
  });
});
