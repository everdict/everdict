import type { ExecutionAttemptRecord, RuntimeWorkRef, VerifierInvocation, VerifierJob } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryExecutionAttemptStore } from "../ports/execution-attempt-store.js";
import { verifierOperation } from "./verifier-operation.js";

// ── THE JUDGING HALF IS DURABLE WORK, OR A CANCELLATION LIES (arch-review 57 P0-verifier) ────────────
//
// arch-review 56 gave the verifier its own container; arch-review 57 gave that container a placement. What
// it still has no place in is the LEDGER. `dispatchVerifier` opens no attempt, reserves no work and reports
// no handle, so nothing downstream can see it:
//
//     scheduler admission     — the compute it takes is not admitted
//     execution attempt row   — nothing records that a second unit was placed
//     cancellation workset    — built from attempt rows, so the verifier is not in it
//     recovery / adoption     — a control plane that restarts mid-verify finds nothing to reconcile
//
// The consequence is the one that matters, and it is the exact thing arch-review 56's cancellation
// certificate was built to end:
//
//     verifier running · user cancels the batch
//     cancellation probes the AGENT's work → absent · children terminal · COMPLETED
//     the verifier keeps running, spending money, and eventually writes a verdict
//
// "Zero live work" was certified over a container the sweep had no way to know about. Rule `protocol` L5
// says completion is a verified zero, and a workset that cannot enumerate what it owes has not enumerated
// zero — it enumerated what it could see.
//
// So the verifier gets what every other piece of managed compute has: an attempt row it opens before it
// places anything, a reservation naming the exact work, and an activation at the seam where the object is
// created. Then the existing cancellation finds it, because the existing cancellation reads attempt rows.
//
// RED as of be210ae6, observed:
//   Cannot find module './verifier-operation.js'

const job = (over: Partial<VerifierJob> = {}): VerifierJob =>
  ({
    runId: "r1",
    tenant: "acme",
    caseId: "c1",
    workdir: "/app",
    workspace: { kind: "repo", diff: "", changedFiles: [], headSha: "abc" },
    plan: { digest: "sha256:plan", graders: [{ id: "reward-file", config: {} }] },
    timeoutSec: 600,
    ...over,
  }) as VerifierJob;

const invocation: VerifierInvocation = {
  planDigest: "sha256:plan",
  workspaceDigest: "sha256:workspace",
  scores: [{ graderId: "reward-file", metric: "tests_pass", value: 1, pass: true }],
};

const work = (id: string): RuntimeWorkRef => ({ tenant: "acme", runId: "r1", externalJobId: id });

describe("[R57 COUNTEREXAMPLE] a verifier is durable work the cancellation can find", () => {
  it("opens its OWN attempt row — the agent's is already committed by then", async () => {
    const attempts = new InMemoryExecutionAttemptStore();
    await verifierOperation({ attempts }, job(), async () => invocation);

    const rows = await attempts.list("r1");
    expect(rows, "the verifier placed compute the ledger has no row for").toHaveLength(1);
    expect(rows[0]?.caseId, "the verifier's row is indistinguishable from the agent's").toContain("verify");
  });

  it("reserves the work BEFORE the lane creates it, and the row names that exact id", async () => {
    const attempts = new InMemoryExecutionAttemptStore();
    const seen: string[] = [];
    await verifierOperation({ attempts }, job(), async (_j, hooks) => {
      seen.push("dispatch");
      await hooks.onReserved(work("everdict-verify-1"));
      return invocation;
    });

    const rows = await attempts.list("r1");
    expect(rows[0]?.runtimeWork?.externalJobId).toBe("everdict-verify-1");
    expect(seen).toEqual(["dispatch"]);
  });

  it("puts the verifier's work where a cancellation READS — the same attempt ledger", async () => {
    // The whole point: cancellation builds its workset from attempt rows. A verifier absent from them is a
    // container a completed cancellation never knew to stop.
    const attempts = new InMemoryExecutionAttemptStore();
    await verifierOperation({ attempts }, job(), async (_j, hooks) => {
      await hooks.onReserved(work("everdict-verify-1"));
      return invocation;
    });
    const handles = (await attempts.list("r1")).flatMap((a: ExecutionAttemptRecord) =>
      a.runtimeWork ? [a.runtimeWork] : [],
    );
    expect(handles.map((h) => h.externalJobId)).toContain("everdict-verify-1");
  });

  it("SETTLES the row when the verdict comes back — a live row is compute a sweep will chase", async () => {
    const attempts = new InMemoryExecutionAttemptStore();
    await verifierOperation({ attempts }, job(), async (_j, hooks) => {
      await hooks.onReserved(work("everdict-verify-1"));
      return invocation;
    });
    expect((await attempts.list("r1"))[0]?.state).toBe("committed");
  });

  it("settles it on FAILURE too — an abandoned row is owed forever", async () => {
    const attempts = new InMemoryExecutionAttemptStore();
    await expect(
      verifierOperation({ attempts }, job(), async () => {
        throw new Error("cluster refused the verifier job");
      }),
    ).rejects.toThrow(/cluster refused/);
    expect((await attempts.list("r1"))[0]?.state).toBe("failed");
  });

  it("still dispatches where no ledger is wired — the CLI has no attempt store", async () => {
    // A deployment with no ledger records nothing and must not therefore refuse to judge.
    const out = await verifierOperation({}, job(), async () => invocation);
    expect(out.scores).toHaveLength(1);
  });
});
