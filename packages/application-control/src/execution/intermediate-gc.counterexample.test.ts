import type { CaseResult, RunRecord } from "@everdict/contracts";
import { CaseResultSchema, storedExecutionId } from "@everdict/contracts";
import { contentDigest } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import type { Dispatcher } from "../ports/dispatcher.js";
import { InMemoryExecutionAttemptStore } from "../ports/execution-attempt-store.js";
import type { AttemptStamp, RunStore } from "../ports/run-store.js";
import { RunService } from "../run/run-service.js";
import { type AgentHalfStore, agentHalfDigest, stageAgentHalf, stageVerifierVerdict } from "./agent-half.js";

// ── THE SETTLEMENT OWNS THE DISCARD, AND DID NOT PERFORM IT (arch-review 64 P1-high) ─────────────────
//
// `recoverVerifiedCase` carries the sentence "The settlement owns the discard — see `discardAgentHalf`'s
// callers". Its callers did not keep it: `discardAgentHalf` had exactly ONE production caller, the standalone
// RECOVERY. The ordinary path — a private-verifier case that completes without anything crashing — never
// discarded, and neither did the batch committer or the batch recovery.
//
// So every such case left a full intermediate `CaseResult` in object storage forever: the trace, the
// workspace snapshot, the observation scores, the runtime provenance. That duplicates the case's own evidence
// under a key nothing references and nothing sweeps, which is a RETENTION and disclosure problem rather than
// a storage one. The comment-is-a-claim law, in its most expensive form: the promise was three frames away
// and nobody looked.
//
// Seen RED before the settlement discarded, observed:
//   the settlement left the case's intermediates in storage forever: expected [ 'agent-half/…', 'verifier-verdict/…' ] to have a length of +0

const RUN = "r1";
const EXECUTION = storedExecutionId("evd-run-r1");

const AGENT_HALF: CaseResult = CaseResultSchema.parse({
  caseId: "c1",
  harness: "cc@1.0.0",
  trace: [{ t: 0, kind: "log", stream: "stdout", text: "the agent ran" }],
  scores: [{ graderId: "steps", metric: "steps", value: 7 }],
  snapshot: { kind: "repo", diff: "diff --git a/x b/x", changedFiles: [], base: "base-sha", headSha: "head-sha" },
});

const DIGEST = agentHalfDigest(AGENT_HALF);

// The settled document: the merged case, carrying the receipt whose handle names WHICH half it was judged
// from. That coordinate is the only thing a settlement has to find the intermediates with.
const SETTLED: CaseResult = {
  ...AGENT_HALF,
  verifier: {
    planDigest: "sha256:plan",
    workspaceDigest: contentDigest(AGENT_HALF.snapshot),
    scores: [{ graderId: "reward-file", metric: "tests_pass", value: 1, pass: true }],
    work: {
      tenant: "acme",
      runId: "evd-run-r1",
      externalJobId: "everdict-verify-c1",
      attemptId: "a-verify",
      verifier: {
        planDigest: "sha256:plan",
        workspaceDigest: contentDigest(AGENT_HALF.snapshot),
        caseId: "c1",
        agentResultDigest: DIGEST,
      },
    },
    complete: true,
  },
} as unknown as CaseResult;

const RECORD: RunRecord = {
  id: RUN,
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

function artifactStore(): AgentHalfStore & { keys: () => string[] } {
  const objects = new Map<string, Uint8Array>();
  return {
    async put(key: string, data: Uint8Array) {
      objects.set(key, data);
      return key;
    },
    async get(key: string) {
      return objects.get(key);
    },
    async remove(key: string) {
      objects.delete(key);
    },
    keys: () => [...objects.keys()],
  };
}

// A run store with the atomic seam, so the settlement takes the path production takes.
function storeWithSeam(record: RunRecord, opts?: { refuse?: boolean }): RunStore {
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
      if (opts?.refuse) return undefined; // the fence was lost — somebody else owns this run
      const cur = rows.get(id);
      if (!cur) return undefined;
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

const staged = async () => {
  const artifacts = artifactStore();
  await stageAgentHalf(artifacts, "acme", "evd-run-r1", AGENT_HALF);
  await stageVerifierVerdict(artifacts, "acme", "evd-run-r1", DIGEST, {
    planDigest: "sha256:plan",
    workspaceDigest: contentDigest(AGENT_HALF.snapshot),
    scores: [{ graderId: "reward-file", metric: "tests_pass", value: 1, pass: true }],
  } as never);
  return artifacts;
};

describe("[R64 COUNTEREXAMPLE] a settlement ends the window it was staged for", () => {
  it("discards BOTH intermediates when the run settles", async () => {
    const artifacts = await staged();
    expect(artifacts.keys(), "nothing was staged, so this file measured nothing").toHaveLength(2);

    const attempts = new InMemoryExecutionAttemptStore();
    const { attemptId } = await attempts.open({ executionId: EXECUTION, tenant: "acme" });
    const store = storeWithSeam(RECORD);
    const service = new RunService({
      dispatcher: unusedDispatcher,
      store,
      attempts,
      agentHalves: artifacts,
      verdicts: artifacts,
    });
    (service as unknown as { attemptRow: Map<string, string> }).attemptRow.set(EXECUTION, attemptId);

    await service.resume(RECORD, SETTLED, { ownerReplica: "r1", epoch: 1 } as never, attemptId);

    expect((await store.get(RUN))?.status, "the run never settled, so the assertion below is vacuous").toBe(
      "succeeded",
    );
    expect(artifacts.keys(), "the settlement left the case's intermediates in storage forever").toHaveLength(0);
  });

  it("KEEPS them when the settlement was refused", async () => {
    // The control, and the one that matters most. A lost fence means somebody else owns this run and their
    // settlement is what ends the window — discarding here would delete the halves out from under the
    // process that is about to need them (rule `protocol`: the window ends at the settlement that LANDED).
    const artifacts = await staged();
    const attempts = new InMemoryExecutionAttemptStore();
    const { attemptId } = await attempts.open({ executionId: EXECUTION, tenant: "acme" });
    const service = new RunService({
      dispatcher: unusedDispatcher,
      store: storeWithSeam(RECORD, { refuse: true }),
      attempts,
      agentHalves: artifacts,
      verdicts: artifacts,
    });
    (service as unknown as { attemptRow: Map<string, string> }).attemptRow.set(EXECUTION, attemptId);

    await service.resume(RECORD, SETTLED, { ownerReplica: "r1", epoch: 1 } as never, attemptId);

    expect(artifacts.keys(), "a refused settlement deleted the halves the winner still needs").toHaveLength(2);
  });

  it("touches nothing for a case with no judging half", async () => {
    // The other control: the coordinate comes off the RECEIPT, so a result with none discards nothing rather
    // than guessing a key — a guessed key deletes another execution's bytes.
    const artifacts = await staged();
    const attempts = new InMemoryExecutionAttemptStore();
    const { attemptId } = await attempts.open({ executionId: EXECUTION, tenant: "acme" });
    const service = new RunService({
      dispatcher: unusedDispatcher,
      store: storeWithSeam(RECORD),
      attempts,
      agentHalves: artifacts,
      verdicts: artifacts,
    });
    (service as unknown as { attemptRow: Map<string, string> }).attemptRow.set(EXECUTION, attemptId);

    await service.resume(RECORD, AGENT_HALF, { ownerReplica: "r1", epoch: 1 } as never, attemptId);

    expect(artifacts.keys()).toHaveLength(2);
  });
});
