import type { RecoveryTarget } from "@everdict/application-control";
import { describe, expect, it } from "vitest";
import { recoverStandaloneRun } from "./runtime-access.js";

// ── A VERIFIER'S VERDICT IS NOT THE RUN'S RESULT (arch-review 60 P0) ────────────────────────────────
//
// A run with a private verifier holds TWO work handles under ONE execution id: the agent's Job and the
// verifier's. Boot recovery enumerates them and takes the FIRST that answers `adopted`.
//
// `adoptWork` used to answer a `CaseResult` for both, because the verifier's scores had to reach a caller
// that wanted that shape. The shell it built carried a comment saying nothing persists it — and then
// something did. `RunService.resume` hands whatever it was given to `Run.adopt`, which writes
// `status: "succeeded"` with that value as the run's result and asks nothing about where it came from:
//
//     agent Job finished — its result lives only in the dead control plane's memory, its Job already reaped
//     verifier Job still running
//     crash · recovery: agent handle ABSENT · verifier handle ADOPTED
//     → run succeeded, harness "verifier", no agent trace, no snapshot, the verifier's scores as the
//       case's whole evidence
//
// The final record is a verdict standing in for the execution it was a verdict ABOUT. That is not a lost
// result, it is a substituted one — the evidence document says a different thing than the case did, and
// nothing downstream can tell, because a value shaped like the final document IS the final document to every
// caller that does not ask.
//
// So adoption answers a stage-tagged union and this loop names the case it settles. Skipped rather than
// treated as absent or unknown: this handle says nothing about whether the AGENT's half is recoverable, and
// the verifier's own attempt row settles on its own path. Falling through to the no-adoption path is the
// honest answer — the agent's evidence is gone, so the run re-drives or tombstones under its own fence,
// which is exactly what it already does when nothing adopts.
//
// Seen RED before the stage travelled, observed:
//   a verifier's verdict was settled as the run's own result: expected 'verifier' to be undefined

const target = (id: string): RecoveryTarget =>
  ({ kind: "run", id, authority: { ownerReplica: "r1", epoch: 1 }, attempts: 1 }) as unknown as RecoveryTarget;

const RECORD = { id: "r1", tenant: "acme", status: "running", ownerReplica: "r1", ownerEpoch: 1 };

// A crashed run whose agent Job is gone and whose verifier Job is still there — the shape the whole file is
// about. `resumedWith` records what the settle path was actually handed.
function world(resumedWith: Array<unknown>) {
  return {
    scorecardStore: { get: async () => undefined },
    store: { get: async () => RECORD },
    owner: "r1",
    replicas: { alive: async () => [] },
    scorecardService: { resume: async () => ({ kind: "resumed" }) },
    service: {
      resume: async (_r: unknown, adopted: unknown) => {
        resumedWith.push(adopted);
        return { kind: "resumed" };
      },
    },
    workHandlesFor: async () => [
      // The agent's handle first, exactly as the ledger holds them, and it is gone.
      { tenant: "acme", runId: "evd-run-r1", externalJobId: "everdict-c1-agent" },
      { tenant: "acme", runId: "evd-run-r1", externalJobId: "everdict-verify-c1" },
    ],
    adoptWorkFn: async (_t: string, _rt: unknown, work: { externalJobId: string }) =>
      work.externalJobId.includes("verify")
        ? {
            kind: "adopted",
            adopted: {
              stage: "verifier",
              invocation: { planDigest: "sha256:plan", workspaceDigest: "sha256:ws", scores: [] },
            },
          }
        : { kind: "absent" },
  } as unknown as Parameters<typeof recoverStandaloneRun>[0];
}

describe("[R60 COUNTEREXAMPLE] a recovered verifier verdict never becomes the run's result", () => {
  it("does NOT settle the run with the verifier's answer", async () => {
    const resumedWith: Array<unknown> = [];
    await recoverStandaloneRun(world(resumedWith), RECORD as never, { ownerReplica: "r1", epoch: 1 } as never);

    expect(resumedWith, "the settle path was never reached, so this test measured nothing").toHaveLength(1);
    const adopted = resumedWith[0] as { harness?: string } | undefined;
    expect(adopted?.harness, "a verifier's verdict was settled as the run's own result").toBeUndefined();
    // …and specifically: nothing was adopted at all, which routes to the re-drive. The agent's evidence is
    // gone; inventing a result from the other half would be worse than admitting that.
    expect(adopted, "something other than the agent's own half was adopted").toBeUndefined();
  });

  it("STILL adopts the agent's own half when that is what answered", async () => {
    // The control. Refusing the verifier's answer must not cost the case the answer it exists to recover —
    // otherwise this file would be passing because adoption stopped working.
    const resumedWith: Array<unknown> = [];
    const w = world(resumedWith) as unknown as {
      adoptWorkFn: unknown;
    };
    w.adoptWorkFn = async (_t: string, _rt: unknown, work: { externalJobId: string }) =>
      work.externalJobId.includes("verify")
        ? { kind: "absent" }
        : {
            kind: "adopted",
            adopted: { stage: "case", result: { caseId: "c1", harness: "agent@1", trace: [], scores: [] } },
          };

    await recoverStandaloneRun(w as never, RECORD as never, { ownerReplica: "r1", epoch: 1 } as never);
    expect((resumedWith[0] as { harness?: string } | undefined)?.harness).toBe("agent@1");
  });
});
