import type { CaseResult, RunRecord } from "@everdict/contracts";
import { storedExecutionId } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { Dispatcher } from "../ports/dispatcher.js";
import { InMemoryExecutionAttemptStore } from "../ports/execution-attempt-store.js";
import type { AttemptStamp, RunStore } from "../ports/run-store.js";
import { RunService } from "../run/run-service.js";

// ── ONE CASE, TWO PHYSICAL EXECUTIONS, ONE DECISION (arch-review 64 P1-high) ─────────────────────────
//
// A private-verifier case runs twice: the agent's container, then a judging container the agent was never in.
// Both open attempt rows under the SAME execution id, and the settlement adopted only the first.
//
// Before `verdict_produced` the verifier's row was stamped `committed` by the lane itself, which hid the gap:
// the row looked settled, and what it claimed — "this attempt's result is the case's answer" — was a claim
// the lane had no standing to make. Now the lane stops at `verdict_produced` and the settlement is the only
// writer of `committed`, so the gap is visible: without this adoption the verdict's row waits forever, a
// teardown keeps reading it as live work, and the phase becomes the leak-with-a-comment the phase-readers law
// is about.
//
// Driven through `RunService.resume` — the public settlement `recoverStandaloneRun` calls — against the REAL
// attempt store, because the adoption is a property of the settlement: a test that stamped the rows itself
// would prove only that the store can write them (rule `testing`, and the production-composition rule this
// review added). The run store is a fake with the atomic seam, which is the seam under test.
//
// Seen RED with the verifier arm removed from the stamp, observed:
//   the verdict's own row was never adopted by the settlement that used it: expected 'verdict_produced' to be 'committed'

const EXECUTION = storedExecutionId("evd-run-r1");

const RECORD: RunRecord = {
  id: "r1",
  tenant: "acme",
  harness: { id: "cc", version: "1.0.0" },
  caseId: "c1",
  status: "running",
  runtime: "nomad-dev",
  createdAt: "2026-08-24T00:00:00.000Z",
  updatedAt: "2026-08-24T00:00:00.000Z",
};

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("not under test");
  },
};

// The world at the moment of settlement: the agent's attempt has executed, the verifier's has produced its
// verdict, and the result carries the receipt naming that verifier attempt.
const twoHalves = async () => {
  const attempts = new InMemoryExecutionAttemptStore();

  const agent = await attempts.open({ executionId: EXECUTION, tenant: "acme" });
  await attempts.reserveWork(agent.attemptId, {
    tenant: "acme",
    runId: "evd-run-r1",
    externalJobId: "everdict-c1-agent",
  });

  const verifier = await attempts.open({ executionId: EXECUTION, tenant: "acme", caseId: "c1#verify" });
  await attempts.reserveWork(verifier.attemptId, {
    tenant: "acme",
    runId: "evd-run-r1",
    externalJobId: "everdict-c1-verify",
  });
  await attempts.transition(verifier.attemptId, "verdict_produced");

  return { attempts, agentAttempt: agent.attemptId, verifierAttempt: verifier.attemptId };
};

const resultWith = (verifierAttemptId: string): CaseResult =>
  ({
    caseId: "c1",
    harness: "cc@1.0.0",
    trace: [],
    scores: [{ graderId: "reward-file", metric: "tests_pass", value: 1, pass: true }],
    snapshot: { kind: "repo", diff: "" },
    verifier: {
      planDigest: "sha256:plan",
      workspaceDigest: "sha256:tree",
      scores: [{ graderId: "reward-file", metric: "tests_pass", value: 1, pass: true }],
      work: { tenant: "acme", runId: "evd-run-r1", externalJobId: "everdict-c1-verify", attemptId: verifierAttemptId },
      complete: true,
    },
  }) as unknown as CaseResult;

const stateOf = async (attempts: InMemoryExecutionAttemptStore, attemptId: string) =>
  (await attempts.list(EXECUTION)).find((a) => a.attemptId === attemptId)?.state;

// A run store with the ATOMIC SEAM, because that is the seam under test: `settleWith` is what makes the
// terminal write and the attempt stamps one decision, and a store without it routes the lane to a different
// path entirely. Everything else here is the smallest thing that answers.
function storeWithSeam(record: RunRecord): RunStore {
  const rows = new Map<string, RunRecord>([[record.id, record]]);
  return {
    async create(r: RunRecord) {
      rows.set(r.id, r);
    },
    async update(id: string, patch: Partial<RunRecord>) {
      const cur = rows.get(id);
      if (!cur) return undefined;
      const next = { ...cur, ...patch, id: cur.id };
      rows.set(id, next);
      return next;
    },
    async settleWith(id: string, patch: Partial<RunRecord>, _events: unknown, _guard: unknown, stamp: AttemptStamp) {
      const cur = rows.get(id);
      if (!cur) return undefined;
      // The ORDER production uses: the stamps land inside the settlement, and a store fault in them takes the
      // terminal write with it (arch-review 63's ordering fix).
      await stamp.apply(stamp.attempts);
      const next = { ...cur, ...patch, id: cur.id };
      rows.set(id, next);
      return next;
    },
    async get(id: string) {
      return rows.get(id);
    },
    async list() {
      return [...rows.values()];
    },
    async deleteByScorecard() {
      return 0;
    },
    async countActiveByEnvelope() {
      return 0;
    },
    async inFlightByTenant() {
      return {};
    },
    async liveSessions() {
      return [];
    },
  } as unknown as RunStore;
}

describe("[R64 COUNTEREXAMPLE] a settlement adopts every attempt whose work it used", () => {
  const settleVia = async (build: (verifierAttemptId: string) => CaseResult) => {
    const { attempts, agentAttempt, verifierAttempt } = await twoHalves();
    const store = storeWithSeam(RECORD);
    const service = new RunService({ dispatcher: unusedDispatcher, store, attempts });

    // The public recovery settlement, driven the way `recoverStandaloneRun` drives it: the adopted document
    // and the attempt it came from.
    const outcome = await service.resume(
      RECORD,
      build(verifierAttempt),
      { ownerReplica: "r1", epoch: 1 } as never,
      agentAttempt,
    );
    return { attempts, agentAttempt, verifierAttempt, store, outcome };
  };

  it("adopts BOTH rows, in the write that settles the run", async () => {
    const { attempts, agentAttempt, verifierAttempt, store, outcome } = await settleVia(resultWith);

    // The controls first, or nothing below is about a settlement that happened.
    expect(outcome.kind, "the resume did not settle, so this file measured nothing").toBe("resumed");
    expect((await store.get("r1"))?.status).toBe("succeeded");

    expect(await stateOf(attempts, agentAttempt)).toBe("committed");
    expect(
      await stateOf(attempts, verifierAttempt),
      "the verdict's own row was never adopted by the settlement that used it",
    ).toBe("committed");
  });

  it("leaves a verifier row alone when the result carries no verdict", async () => {
    // The control in the other direction. A case with no judging half must not have some other execution's
    // row swept into its settlement — the adoption is driven by the RECEIPT, so a result carrying none adopts
    // nothing extra.
    const { attempts, agentAttempt, verifierAttempt } = await settleVia(
      () =>
        ({
          caseId: "c1",
          harness: "cc@1.0.0",
          trace: [],
          scores: [],
          snapshot: { kind: "repo", diff: "" },
        }) as unknown as CaseResult,
    );

    expect(await stateOf(attempts, agentAttempt)).toBe("committed");
    expect(await stateOf(attempts, verifierAttempt), "a settlement adopted a verdict it never used").toBe(
      "verdict_produced",
    );
  });
});
