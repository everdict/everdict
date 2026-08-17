import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ── THE STRUCTURAL HALF OF "EXACT ADDRESSING IS THE DEFAULT" (arch-review 53, Wave B) ────────────────
//
// The case-id control surface (`adopt` · `logs` · `caseEvents` · `exec` · `inspectCase` · `sampleCase`) still
// exists, and deliberately: pre-handle ledger rows have nothing else, and a human tailing a log through the
// UI is not deciding anything. What it must never do again is resolve a question whose answer CHANGES A
// RECORD — because its resolution is "the newest job carrying this case label", and two runs of one case are
// two jobs, so it answers about whichever the cluster created last.
//
// `adopt` is the one that made this urgent: boot recovery harvests a job and hands the result back as the
// execution's own, so a case-id adopt can attribute run B's bytes to run A's receipt.
//
// This scan is the ban. Recovery, cancellation and decision files use the `RuntimeWorkRef` twins
// (`adoptWork` · `logsForWork` · `eventsForWork` · `execInWork` · `inspectWork` · `sampleWork`); everything
// else may keep using the case-id form, which is why the scan is scoped to those files rather than global.
const DECISION_FILES = [
  // Boot recovery: adoption decides which bytes settle a run.
  "apps/api/src/composition/runtime-access.ts",
  // The run's teardown and its evidence read.
  "packages/application-control/src/run/run-service.ts",
  // The batch's commit point and its recovery planner.
  "packages/application-control/src/scorecard/case-outcome-committer.ts",
  "packages/application-control/src/scorecard/recovery-planner.ts",
];

// The legacy calls, by the shape they take at a call site. `backend.adopt(` and friends — never the
// definitions, which live in the orchestrator files this scan does not cover.
const LEGACY_CALL = /\.(adopt|logs|caseEvents|exec|execStream|inspectCase|sampleCase)\s*\(\s*(caseId|[a-z]\w*\.caseId)/;

// A file may hold the legacy call this many times, each entry saying why it is not a decision.
const ALLOWED = new Map<string, number>([
  // The composition's lane functions each keep their case-id branch as the documented fallback for a caller
  // that holds no handle (pre-Wave-2 rows, lanes that mint none). Every one of them takes the handle when it
  // is offered and uses the exact twin then — `adoptCaseFn`, `readCaseLogsFn`, `readCaseEventsFn`,
  // `openTerminalStreamFn`, `execInSandboxFn`, `inspectCasePlacementFn`. What the scan still forbids is a
  // decision path with NO exact branch at all.
  ["apps/api/src/composition/runtime-access.ts", 6],
]);

const repoRoot = new URL("../../../../", import.meta.url).pathname;

describe("the legacy-case-addressing scanner — a decision is never resolved by case id", () => {
  it("no recovery, cancellation or decision path addresses live work by case id", () => {
    const offences: string[] = [];
    for (const relative of DECISION_FILES) {
      let source: string;
      try {
        source = readFileSync(join(repoRoot, relative), "utf8");
      } catch {
        continue; // a renamed file is caught by the self-check below, not reported as an offence here
      }
      let found = 0;
      for (const [index, line] of source.split("\n").entries()) {
        if (!LEGACY_CALL.test(line)) continue;
        found++;
        if (found <= (ALLOWED.get(relative) ?? 0)) continue;
        offences.push(`${relative}:${index + 1} — ${line.trim()}`);
      }
    }
    expect(
      offences,
      `a decision path resolves live work by CASE ID, which addresses whichever job of that case the cluster created last — use the RuntimeWorkRef twin (adoptWork/logsForWork/eventsForWork/execInWork/inspectWork/sampleWork):\n${offences.join("\n")}`,
    ).toEqual([]);
  });

  it("the scanned files still exist", () => {
    // A scan pointed at renamed files passes forever. Every path it names must be real.
    for (const relative of DECISION_FILES)
      expect(statSync(join(repoRoot, relative)).isFile(), `${relative} is scanned and gone`).toBe(true);
  });

  it("the exact-work twins exist on every managed backend", () => {
    // The ban is only enforceable if the alternative is there. Both managed backends implement the full
    // surface — a partial implementation would put a caller back to guessing which reads are exact.
    const dir = new URL(".", import.meta.url).pathname;
    const managed = readdirSync(dir).filter((f) => f === "k8s.ts" || f === "nomad.ts");
    expect(managed).toHaveLength(2);
    for (const file of managed) {
      const source = readFileSync(join(dir, file), "utf8");
      for (const method of ["adoptWork", "logsForWork", "eventsForWork", "execInWork", "inspectWork", "sampleWork"])
        expect(source.includes(`async ${method}(`), `${file} does not implement ${method}`).toBe(true);
    }
  });
});
