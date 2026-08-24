import type { CaseJob, CaseResult, RunRecord, VerifierInvocation } from "@everdict/contracts";
import { UpstreamError, storedExecutionId } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { Dispatcher } from "../ports/dispatcher.js";
import { InMemoryExecutionAttemptStore } from "../ports/execution-attempt-store.js";
import { InMemoryIntermediateCleanupStore } from "../ports/intermediate-cleanup-store.js";
import type { AttemptStamp, RunStore } from "../ports/run-store.js";
import { RunService } from "../run/run-service.js";
import type { AgentHalfStore } from "./agent-half.js";
import { withVerifierPass } from "./verifier-pass.js";

// ── EVERY ENDING OWNS ITS GC DEBT, NOT ONLY THE ONE THAT SUCCEEDED (arch-review 65 P1-high) ─────────
//
// The cleanup coordinate was read out of `result.verifier.work.verifier.agentResultDigest` — a path that
// exists only on a case that settled WITH a complete verifier receipt. So the settlement could end the window
// for exactly the ending that did not need any help, and three that did were left with nothing addressing
// their bytes:
//
//     the verifier container errored          `owed("grader_error")`  — no receipt
//     the merge refused the verdict           `owed("grader_error")`  — no receipt, and a staged VERDICT too
//     a capacity refusal was retried          rethrown                — a new agent half every attempt
//
// Each of those leaves a full intermediate `CaseResult` — trace, workspace snapshot, observation scores,
// runtime provenance — in object storage forever, under a key nothing references and nothing sweeps. That is
// the retention problem arch-review 64 closed for the happy path and left open for every other one.
//
// The intermediates are written BEFORE any of those endings is decided, so the coordinate cannot live in the
// document that happens to succeed.
//
// ── …AND THE COORDINATE IS NOT ON THE DOCUMENT AT ALL NOW (arch-review 66) ──────────────────────────
//
// arch-review 65 stamped the refs onto every outcome. Right problem, wrong document: `CaseResult` is the
// measurement, and platform lifecycle state on it made the recovered document differ from the normal one
// (two different digests for one execution) and let a self-hosted runner name objects for deletion through
// `submit_job_result`. The debt is a LEDGER ROW now, written by the staging itself, so this file asserts
// what the execution OWES rather than what its document happens to carry.
//
// Seen RED with the debt not recorded at stage time, observed:
//   a verifier that errored left its agent half owed to nobody: expected [] to have a length of 1
//
// ⚠️ THIS IS THE HALF THE EXISTING GC COUNTEREXAMPLE CANNOT SEE. That file settles a case carrying a complete
// receipt, so the successful ending answers and the test passes either way. A file that is green under the
// change it exists to pin is measuring the wrong thing (rule `testing`).

const RUN = "evd-run-r1";
const EXECUTION = storedExecutionId(RUN);

const JOB: CaseJob = {
  tenant: "acme",
  runId: RUN,
  harness: { id: "h", version: "1" },
  evalCase: {
    id: "c1",
    task: "t",
    env: { kind: "repo", source: { path: "/app" } },
    // PRIVATE by its config carrying material the agent must not see — that is what makes a verifier plan at
    // all. A hand-invented flag produces no plan and `withVerifierPass` then just forwards the dispatch.
    graders: [{ id: "reward-file", config: { files: { "tests/test.sh": "exit 0" } } }],
    timeoutSec: 60,
    tags: [],
  },
} as unknown as CaseJob;

const AGENT_RESULT: CaseResult = {
  caseId: "c1",
  harness: "h@1",
  trace: [{ t: 0, kind: "log", stream: "stdout", text: "the agent ran" }],
  scores: [{ graderId: "steps", metric: "steps", value: 7 }],
  snapshot: { kind: "repo", diff: "diff --git a/x b/x", changedFiles: [], base: "b", headSha: "h" },
} as unknown as CaseResult;

const RECORD: RunRecord = {
  id: "r1",
  tenant: "acme",
  harness: { id: "h", version: "1" },
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

function storeWithSeam(): RunStore {
  const rows = new Map<string, RunRecord>([[RECORD.id, RECORD]]);
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
    async settleWith(id: string, patch: Partial<RunRecord>, _e: unknown, _g: unknown, stamp: AttemptStamp) {
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

// The failure, driven through the REAL pass so the world under test is the one production produces — a
// hand-recorded debt would assert the assertion.
async function caseEndedByAVerifierError(
  artifacts: AgentHalfStore,
  cleanup: InMemoryIntermediateCleanupStore,
): Promise<CaseResult> {
  return await withVerifierPass(JOB, {
    dispatch: async () => AGENT_RESULT,
    agentHalves: artifacts,
    cleanup,
    dispatchVerifier: async (): Promise<VerifierInvocation> => {
      throw new UpstreamError("UPSTREAM_ERROR", {}, "the verifier container crashed");
    },
  } as never);
}

async function settle(
  artifacts: AgentHalfStore,
  result: CaseResult,
  cleanup?: InMemoryIntermediateCleanupStore,
): Promise<void> {
  const attempts = new InMemoryExecutionAttemptStore();
  const { attemptId } = await attempts.open({ executionId: EXECUTION, tenant: "acme" });
  const service = new RunService({
    dispatcher: unusedDispatcher,
    store: storeWithSeam(),
    attempts,
    agentHalves: artifacts,
    verdicts: artifacts,
    ...(cleanup ? { cleanup } : {}),
  });
  (service as unknown as { attemptRow: Map<string, string> }).attemptRow.set(EXECUTION, attemptId);
  await service.resume(RECORD, result, { ownerReplica: "r1", epoch: 1 } as never, attemptId);
}

describe("[R66 COUNTEREXAMPLE] a case that could not be judged still cleans up after itself", () => {
  it("OWES what it staged on an ending that has no receipt", async () => {
    const artifacts = artifactStore();
    const cleanup = new InMemoryIntermediateCleanupStore();
    const result = await caseEndedByAVerifierError(artifacts, cleanup);

    // The premise: the pass really did stage, and really did end unjudged. Without both, everything below is
    // an assertion about a case that never wrote anything.
    expect(artifacts.keys(), "nothing was staged, so this file measures nothing").toHaveLength(1);
    expect(result.scores?.find((s) => s.metric === "tests_pass")?.status).toBe("unmeasured");
    expect(result.verifier, "this ending has a receipt, so the successful path would answer instead").toBe(undefined);

    // …and the document carries NOTHING about it, which is the trust-domain half of this change.
    expect(
      (result as unknown as Record<string, unknown>).intermediates,
      "the measurement document carries platform cleanup state again",
    ).toBe(undefined);

    const owed = await cleanup.owed("acme", EXECUTION);
    expect(
      owed.map((r) => r.key),
      "the ending left its staged bytes owed to nobody",
    ).toEqual(artifacts.keys());
  });

  it("DISCHARGES the debt when the unjudged case settles", async () => {
    const artifacts = artifactStore();
    const cleanup = new InMemoryIntermediateCleanupStore();
    const result = await caseEndedByAVerifierError(artifacts, cleanup);

    await settle(artifacts, result, cleanup);

    expect(artifacts.keys(), "a verifier that errored left its agent half in storage forever").toHaveLength(0);
    expect(await cleanup.owed("acme", EXECUTION), "the debt outlived the settlement that paid it").toEqual([]);
  });

  it("KEEPS the debt owed when the delete does not converge", async () => {
    // The lifecycle half: an inline delete that failed used to be swallowed and the bytes were owed to
    // nobody. The row stays owed so the reconciler retries — "we could not find out" is an escalation
    // field, never a terminal (rule `protocol` L5).
    const artifacts = artifactStore();
    const cleanup = new InMemoryIntermediateCleanupStore();
    const result = await caseEndedByAVerifierError(artifacts, cleanup);
    const unreachable: AgentHalfStore = {
      put: artifacts.put.bind(artifacts),
      get: artifacts.get.bind(artifacts),
      async remove() {
        throw new Error("the object store is unreachable");
      },
    };

    await settle(unreachable, result, cleanup);

    expect(await cleanup.owed("acme", EXECUTION), "a failed delete discharged the debt anyway").toHaveLength(1);
    expect((await cleanup.due("2999-01-01T00:00:00.000Z", 10)).length, "the reconciler has no worklist").toBe(1);
  });

  it("touches nothing for a case that staged nothing at all", async () => {
    // The control. A case with no verifier plan writes no intermediates, so its settlement has no coordinate
    // and must not invent one — a guessed key deletes another execution's bytes.
    const artifacts = artifactStore();
    const cleanup = new InMemoryIntermediateCleanupStore();
    await artifacts.put(
      "agent-half/acme/evd-run-OTHER/sha256:someone-else.json",
      new TextEncoder().encode("{}"),
      "application/json",
    );

    await settle(artifacts, AGENT_RESULT, cleanup);

    expect(artifacts.keys(), "the settlement deleted bytes belonging to another execution").toHaveLength(1);
  });
});
