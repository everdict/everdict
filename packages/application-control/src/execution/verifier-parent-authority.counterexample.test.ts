import type { CaseJob, CaseResult, EvalCase, Score, VerifierJob } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryExecutionAttemptStore } from "../ports/execution-attempt-store.js";
import { verifierOperation } from "./verifier-operation.js";
import { withVerifierPass } from "./verifier-pass.js";

// ── THE SECOND UNIT BELONGS TO THE SAME PARENT AS THE FIRST (arch-review 58 P0) ──────────────────────
//
// arch-review 57 gave the verifier its own attempt row, on the correct reasoning: the agent's attempt is
// committed by the time a verifier runs, so recording the second unit against it would be writing to a
// settled row. What it did not carry across is WHOSE second unit it is. The agent's attempt is opened with
//
//     { executionId, tenant, scorecardId: cx.scorecardId, caseId, trial, driverEpoch }
//
// and the verifier's with `{ executionId: job.runId, tenant, caseId: '…#verify' }` — no parent at all. Two
// things follow, and both are silent.
//
// FIRST, the reservation is refused. `PARENT_AUTHORIZES` asks whether the attempt's parent is still open, and
// with `scorecard_id IS NULL` it takes the run branch: `'evd-run-' || r.id = a.execution_id`. A batch case's
// execution id is `evd-<batchId>-<caseId>[-t<n>]`, which no run row can ever equal, so the guard that exists
// to refuse a CANCELLED parent refuses a live one instead. Single runs are unaffected — their execution id
// really is `evd-run-<id>` — which is exactly why this reads as working.
//
// SECOND, the cancellation cannot see it. `listForScorecard` filters on `scorecardId`, so a scorecard's
// teardown builds its workset without the verifier row and then certifies zero over a container it never
// looked for (rule `protocol` L5: a debt owns its worklist).
//
// The parent coordinate is not re-derived from the execution id here. `CaseJob.batchId` already IS the
// scorecard's id in the batch path, so it travels as itself (rule `protocol` L3).
//
// RED as of 061d5ace, observed:
//   expected undefined to be 'sc-1' — the verifier job carries no parent
//   expected [] to have a length of 1 — a scorecard teardown cannot see its own verifier attempt

const privateCase = (): EvalCase =>
  ({
    id: "c1",
    task: "make the tests pass",
    env: { kind: "repo", source: { path: "/app" } },
    image: "tasks/repro:1",
    graders: [
      { id: "reward-file", config: { cmd: "bash /tests/test.sh", files: { "test.sh": "assert_it()" } } },
      { id: "steps" },
    ],
    resources: { cpuMillis: 2000, memoryMb: 4096 },
  }) as unknown as EvalCase;

// A batch case, as a driver dispatches one: the execution id names the BATCH, and `batchId` names the record.
const batchJob = (): CaseJob =>
  ({
    runId: "evd-sc-1-c1-t0",
    tenant: "acme",
    batchId: "sc-1",
    trial: 0,
    evalCase: privateCase(),
    harness: { id: "h", version: "1" },
    registryAuths: [{ registry: "ghcr.io", username: "u", password: "p" }],
  }) as unknown as CaseJob;

const agentResult = (): CaseResult =>
  ({
    caseId: "c1",
    harness: "h@1",
    trace: [],
    snapshot: { kind: "repo", diff: "d", changedFiles: ["a"], headSha: "sha" },
    scores: [{ graderId: "steps", metric: "steps", value: 3 }],
  }) as unknown as CaseResult;

const INVOCATION = {
  planDigest: "sha256:plan",
  workspaceDigest: "sha256:workspace",
  scores: [{ graderId: "reward-file", metric: "tests_pass", value: 1, pass: true } as Score],
};

describe("[R58 COUNTEREXAMPLE] a batch case's verifier is recorded under the batch", () => {
  const passFor = async (job: CaseJob) => {
    const verified: VerifierJob[] = [];
    const result = await withVerifierPass(job, {
      dispatch: async () => agentResult(),
      dispatchVerifier: async (v) => {
        verified.push(v);
        return INVOCATION;
      },
    });
    return { verified, result };
  };

  it("names the scorecard the case was dispatched for", async () => {
    const { verified } = await passFor(batchJob());
    expect(verified, "the verifier never ran, so this test is asserting about nothing").toHaveLength(1);
    expect(verified[0]?.scorecardId, "the verifier job carries no parent").toBe("sc-1");
    // The trial travels too: a pass@k batch runs the same case several times, and an attempt that cannot say
    // which trial it judged is one a re-drive cannot tell apart from its predecessor.
    expect(verified[0]?.trial).toBe(0);
  });

  it("leaves a SINGLE RUN's verifier with no parent — its execution id already names one", async () => {
    // Not a formality: stamping a scorecard id here would make `PARENT_AUTHORIZES` look for a scorecard row
    // that does not exist, turning a working path into the broken one.
    const { verified } = await passFor({ ...batchJob(), runId: "evd-run-r1", batchId: undefined } as CaseJob);
    expect(verified[0]?.scorecardId).toBeUndefined();
  });

  it("opens the attempt under that parent, where a teardown can find it", async () => {
    const attempts = new InMemoryExecutionAttemptStore();
    const { verified } = await passFor(batchJob());
    const job = verified[0];
    if (!job) throw new Error("no verifier job");

    await verifierOperation({ attempts }, job, async (_j, hooks) => {
      await hooks.onReserved({ tenant: "acme", runId: job.runId, externalJobId: "verify-1" });
      return INVOCATION;
    });

    const owned = await attempts.listForScorecard("sc-1");
    expect(owned, "a scorecard teardown cannot see its own verifier attempt").toHaveLength(1);
    expect(owned[0]?.caseId).toBe("c1#verify");
  });

  it("carries the world the case declared, and the credentials to pull its image", async () => {
    // arch-review 58 P1: `VerifierJob` has had `resources` and `registryAuths` since Wave I and the producer
    // filled neither, so the judging half ran under the lane's defaults against a registry it could not
    // authenticate to. A schema field with no producer is a promise the wire does not keep.
    const { verified } = await passFor(batchJob());
    expect(verified[0]?.resources, "the verifier judges in a world the case never declared").toEqual({
      cpuMillis: 2000,
      memoryMb: 4096,
    });
    expect(verified[0]?.registryAuths, "the verifier cannot pull the image it is meant to judge").toHaveLength(1);
  });
});
