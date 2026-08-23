import type { CaseResult } from "@everdict/contracts";
import { storedExecutionId } from "@everdict/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectDeferredTrace } from "../execution/collect-trace.js";
import { InMemoryExecutionAttemptStore } from "../ports/execution-attempt-store.js";
import { RecoveryPlanner } from "./recovery-planner.js";

// ── A CRASH CHANGED WHAT THE CASE MEASURED (arch-review 64 P0) ───────────────────────────────────────
//
// `collectDeferredTrace` is the second half of every `traceRef` case, and it is not log tidying: it pulls the
// platform trace, extracts the judge's declared evidence slots, records the `sourceTraceId`, runs the
// deferred observation graders and seals the trajectory. Three paths ran it — `executeCase`, the standalone
// recovery, the retry-failed re-collect — and the batch RecoveryPlanner did not. Its deps did not even carry
// the capability to.
//
// So a scorecard child adopted after a control-plane crash settled with the container's own pre-collection
// document: agent trace only, no evidence, no `sourceTraceId`, no deferred observation scores, `traceSealed`
// absent. The judges then ran over less evidence than the same case would have been judged on had nothing
// crashed — and both documents are `CaseResult`s, so nothing downstream can tell them apart.
//
// The assertion is PARITY, not the presence of fields: the recovered document is compared against what the
// production completion function itself produces from the same input. A test listing fields by hand would
// drift the moment completion grows one, which is the shape that let this gap exist.
//
// Seen RED before the planner completed its adopted result, observed:
//   a crash changed what the case measured, not just when: expected undefined to be 'trace-abc'

const SCORECARD = "sc-1";

const CHILD = {
  id: "child-9f2a3b", // a row id, which is NOT the execution id — see recovery-coordinate for why that matters
  executionId: storedExecutionId("evd-sc-1-c1"),
  caseId: "c1",
  tenant: "acme",
  status: "running" as const,
  harness: { id: "h", version: "1" },
  parentScorecardId: SCORECARD,
  createdAt: "2026-08-24T00:00:00.000Z",
  updatedAt: "2026-08-24T00:00:00.000Z",
};

// What the container handed back: a case whose collection was DEFERRED out of the job. Everything the
// platform holds is still on the platform.
const UNCOLLECTED: CaseResult = {
  caseId: "c1",
  harness: "h@1",
  trace: [{ ts: "2026-08-24T00:00:00.000Z", kind: "log", message: "the agent's own trace" }],
  scores: [{ graderId: "tests", metric: "tests_pass", value: 1, pass: true }],
  snapshot: { kind: "prompt", output: "done" },
  traceRef: { kind: "otel", endpoint: "http://otel:4318", runId: "evd-sc-1-c1" },
} as unknown as CaseResult;

const EVAL_CASE = {
  id: "c1",
  task: "t",
  env: { kind: "prompt" },
  graders: [],
  timeoutSec: 60,
  tags: [],
} as never;

// A platform that HAS the trace — the ordinary case, and the one where skipping collection costs the most.
const traceDeps = () => ({
  sleep: async () => undefined,
  buildTraceSource: () => ({
    fetch: async () => [],
    fetchDetailed: async () => ({
      events: [{ ts: "2026-08-24T00:00:01.000Z", kind: "log" as const, message: "the platform's half" }],
      evidence: { screenshot: "s3://shot.png" },
      traceId: "trace-abc",
    }),
  }),
});

function plannerOver(deps: Record<string, unknown>, attempts: InMemoryExecutionAttemptStore) {
  return new RecoveryPlanner(
    {
      ...traceDeps(),
      runStore: { list: async () => [CHILD] },
      caseReceipts: { list: async () => [] },
      attempts,
      // LAST, so a per-test override is not silently overwritten by the defaults above — which is how the
      // first draft of this file measured nothing at all.
      ...deps,
    } as never,
    {} as never,
    // A committer stub that does exactly one thing: put the result it was handed on the receipt, so the
    // capture below reads the document the planner produced rather than one this file invented.
    { receiptOf: (_id: string, result: CaseResult) => ({ result }) } as never,
    { now: () => "2026-08-24T00:00:00.000Z" },
  );
}

const ledgerHolding = async () => {
  const attempts = new InMemoryExecutionAttemptStore();
  const { attemptId } = await attempts.open({ executionId: CHILD.executionId, tenant: "acme" });
  await attempts.reserveWork(attemptId, {
    tenant: "acme",
    runId: CHILD.executionId,
    externalJobId: "everdict-c1-aaaa",
  });
  return attempts;
};

describe("[R64 COUNTEREXAMPLE] a recovered batch case is completed the way a normal one is", () => {
  // `collectDeferredTrace` stamps its own trace events from `Date.now` — the clock is not injectable there —
  // so comparing two invocations of it would compare two different instants. Frozen, because the claim this
  // file makes is TOTAL equality of the two documents: normalizing the field away instead would quietly
  // exempt whichever field the next drift lands in.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T00:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // The adopted result travels to the commit through the committer, so the planner is stopped at the seam
  // that receives it — the question here is WHAT it received, not what the committer did with it.
  const adoptAndCapture = async () => {
    const seen: CaseResult[] = [];
    const attempts = await ledgerHolding();
    const planner = plannerOver(
      {
        adoptWork: async () => ({ kind: "adopted", adopted: { stage: "case", result: UNCOLLECTED } }),
        caseReceipts: {
          list: async () => [],
          commitCase: async (receipt: { result?: CaseResult }) => {
            if (receipt.result) seen.push(receipt.result);
            return { kind: "lost" as const };
          },
        },
      },
      attempts,
    );
    await planner
      .seedFromLedger({
        scorecardId: SCORECARD,
        tenant: "acme",
        dataset: { id: "d", version: "1", cases: [EVAL_CASE] } as never,
        judges: [],
      })
      .catch(() => undefined);
    return seen;
  };

  it("hands the commit a COMPLETED result, not the container's half", async () => {
    const seen = await adoptAndCapture();
    expect(seen, "the recovery never reached the commit, so this file measured nothing").toHaveLength(1);

    const recovered = seen[0];
    expect(recovered?.sourceTraceId, "a crash changed what the case measured, not just when").toBe("trace-abc");
    expect(recovered?.evidence).toEqual({ screenshot: "s3://shot.png" });
    expect(recovered?.traceSealed).toBe(true);
  });

  it("produces the SAME document the normal completion produces", async () => {
    // The parity assertion, which is the one that will not drift: whatever `collectDeferredTrace` grows next,
    // the recovered document has to grow it too, because they are compared rather than enumerated.
    const [recovered] = await adoptAndCapture();
    const normal = await collectDeferredTrace(traceDeps() as never, "acme", EVAL_CASE, UNCOLLECTED);
    expect(recovered).toEqual(normal);
  });

  it("carries a case whose definition left the dataset VERBATIM", async () => {
    // The control. Completion needs the EvalCase, and a case the re-resolved selection no longer contains
    // cannot be completed against a definition nobody holds — carrying it unchanged is what the sibling
    // retry path does, and it must not be mistaken for the defect above.
    const seen: CaseResult[] = [];
    const attempts = await ledgerHolding();
    const planner = plannerOver(
      {
        adoptWork: async () => ({ kind: "adopted", adopted: { stage: "case", result: UNCOLLECTED } }),
        caseReceipts: {
          list: async () => [],
          commitCase: async (receipt: { result?: CaseResult }) => {
            if (receipt.result) seen.push(receipt.result);
            return { kind: "lost" as const };
          },
        },
      },
      attempts,
    );
    await planner
      .seedFromLedger({
        scorecardId: SCORECARD,
        tenant: "acme",
        dataset: { id: "d", version: "1", cases: [] } as never, // c1 is gone
        judges: [],
      })
      .catch(() => undefined);

    expect(seen[0]?.sourceTraceId).toBeUndefined();
    expect(seen[0]?.trace).toEqual(UNCOLLECTED.trace);
  });

  it("keeps parity on a DEGRADED collection too", async () => {
    // The reachable failure, and the one that matters: the platform is up and answers nothing. Collection is
    // TOTAL — it classifies that on the result rather than throwing — so the recovered document must still
    // be the one the normal path produces, error trace event and all. A `.catch(() => adoptable)` wrapper
    // would be indistinguishable here, which is why the comparison is against the real function.
    const empty = () => ({
      sleep: async () => undefined,
      buildTraceSource: () => ({ fetch: async () => [], fetchDetailed: async () => ({ events: [] }) }),
    });
    const seen: CaseResult[] = [];
    const attempts = await ledgerHolding();
    const planner = plannerOver(
      {
        ...empty(),
        adoptWork: async () => ({ kind: "adopted", adopted: { stage: "case", result: UNCOLLECTED } }),
        caseReceipts: {
          list: async () => [],
          commitCase: async (receipt: { result?: CaseResult }) => {
            if (receipt.result) seen.push(receipt.result);
            return { kind: "lost" as const };
          },
        },
      },
      attempts,
    );
    await planner
      .seedFromLedger({
        scorecardId: SCORECARD,
        tenant: "acme",
        dataset: { id: "d", version: "1", cases: [EVAL_CASE] } as never,
        judges: [],
      })
      .catch(() => undefined);

    const normal = await collectDeferredTrace(empty() as never, "acme", EVAL_CASE, UNCOLLECTED);
    expect(seen[0], "a degraded collection produced a different document on the recovery path").toEqual(normal);
  });
});
