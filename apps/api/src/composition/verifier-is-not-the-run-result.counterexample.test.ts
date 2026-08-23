import type { RecoveryTarget } from "@everdict/application-control";
import { agentHalfDigest } from "@everdict/application-control";
import type { ResumeResult } from "@everdict/application-control";
import type { CaseResult } from "@everdict/contracts";
import { contentDigest } from "@everdict/domain";
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
function world(resumedWith: Array<unknown>, verdict: Array<Record<string, unknown>> = []) {
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
      // …and the verifier's, carrying WHICH physical half it judged (arch-review 62 P1). The workspace
      // digest says which tree; two attempts of one case can share one, so the recovery addresses the
      // staged bytes by the result digest the lane recorded.
      {
        tenant: "acme",
        runId: "evd-run-r1",
        externalJobId: "everdict-verify-c1",
        verifier: {
          planDigest: "sha256:plan",
          workspaceDigest: AGENT_TREE,
          caseId: "c1",
          agentResultDigest: agentHalfDigest(AGENT_HALF),
        },
      },
    ],
    adoptWorkFn: async (_t: string, _rt: unknown, work: { externalJobId: string }) =>
      work.externalJobId.includes("verify")
        ? {
            kind: "adopted",
            adopted: {
              stage: "verifier",
              invocation: { planDigest: "sha256:plan", workspaceDigest: AGENT_TREE, scores: verdict },
            },
          }
        : { kind: "absent" },
  } as unknown as Parameters<typeof recoverStandaloneRun>[0];
}

// ── …AND IS MERGED WHEN THE AGENT'S HALF WAS STAGED (arch-review 60 follow-through) ─────────────────
//
// Refusing to settle the verifier's document was the safety half and it threw the verdict away: the agent's
// evidence lived in the dead process's memory, so there was nothing to merge into and the case re-drove.
//
// `withVerifierPass` stages the agent's result as immutable bytes BEFORE it dispatches the second container —
// which is the moment the backend has already deleted the agent's Job — so a recovery can read that half back
// and finish the SAME merge the in-line path would have. Two spellings of "combine these halves" would make a
// case recovered after a crash a different document from one that finished normally, and both are
// `CaseResult`s, so the difference would be invisible.
//
// Seen RED before the stage existed, observed:
//   a recovered verdict was thrown away even though the agent's half was on file: expected undefined to be
//   'agent@1'

const AGENT_HALF: CaseResult = {
  caseId: "c1",
  harness: "agent@1",
  trace: [],
  scores: [],
  snapshot: { kind: "prompt", output: "x" },
};

// The verdict must be ABOUT the tree the staged half left, or the merge refuses it — which is the check
// arch-review 61 added and which this fixture has to satisfy to reach the behaviour it is testing.
const AGENT_TREE = contentDigest(AGENT_HALF.snapshot);

describe("[R60 COUNTEREXAMPLE] a recovered verifier verdict is merged into the staged agent half", () => {
  const staged = (bytes?: Uint8Array) => ({
    put: async () => "ref",
    get: async () => bytes,
    remove: async () => undefined,
  });

  // A REAL verdict: `verifierReceiptOf` refuses an empty one ("an empty verdict is not a measurement"), and
  // a fixture that never reaches the merge would make every assertion below vacuous.
  const VERDICT = [{ graderId: "reward-file", metric: "tests_pass", value: 1, pass: true }];

  const verifierWorld = (resumedWith: Array<unknown>, halves?: ReturnType<typeof staged>) =>
    ({
      ...(world(resumedWith, VERDICT) as unknown as Record<string, unknown>),
      ...(halves ? { agentHalves: halves } : {}),
    }) as unknown as Parameters<typeof recoverStandaloneRun>[0];

  it("MERGES the verdict onto the agent's own result", async () => {
    const resumedWith: Array<unknown> = [];
    const halves = staged(new TextEncoder().encode(JSON.stringify(AGENT_HALF)));
    await recoverStandaloneRun(
      verifierWorld(resumedWith, halves),
      RECORD as never,
      {
        ownerReplica: "r1",
        epoch: 1,
      } as never,
    );

    const adopted = resumedWith[0] as { harness?: string; verifier?: unknown } | undefined;
    expect(adopted?.harness, "a recovered verdict was thrown away even though the agent's half was on file").toBe(
      "agent@1",
    );
    // …and the verdict really is attached, or this is just the agent half by itself.
    expect(adopted?.verifier, "the verifier's receipt did not reach the merged result").toBeDefined();
  });

  it("CLOSES the attempt row it adopted, so the ledger stops reading as live work", async () => {
    // Adoption reads a finished container's answer and deletes its Job. On the in-line path
    // `verifierOperation` settles the attempt row; after a restart that code never runs, so a recovery could
    // settle the run `succeeded`, remove the external object, and leave the physical row saying `active` or
    // `executing` forever — a teardown chasing work that is gone, and an operator told a container is
    // running when none is (arch-review 61 P2-audit).
    const resumedWith: Array<unknown> = [];
    const closed: Array<[string, string]> = [];
    const halves = staged(new TextEncoder().encode(JSON.stringify(AGENT_HALF)));
    const w = {
      ...(verifierWorld(resumedWith, halves) as unknown as Record<string, unknown>),
      // ── THE LANE HANDS THE ATTEMPT TO THE SETTLEMENT (arch-review 63 P1-high) ────────────────────
      //
      // This used to assert that the LANE stamped the row. It did — and the stamp was refused every time,
      // because `committed` requires the parent to be open and the settle that precedes it is what closes
      // it. The stamp is part of `settleRun` now, so what this lane owes is WHICH attempt answered.
      service: {
        resume: async (_r: unknown, adopted: unknown, _a: unknown, attemptId?: string) => {
          resumedWith.push(adopted);
          if (attemptId !== undefined) closed.push([attemptId, "committed"]);
          return { kind: "resumed" };
        },
      },
      workHandlesFor: async () => [
        {
          tenant: "acme",
          runId: "evd-run-r1",
          externalJobId: "everdict-verify-c1",
          attemptId: "a-verify",
          verifier: {
            planDigest: "sha256:plan",
            workspaceDigest: AGENT_TREE,
            caseId: "c1",
            agentResultDigest: agentHalfDigest(AGENT_HALF),
          },
        },
      ],
    } as unknown as Parameters<typeof recoverStandaloneRun>[0];

    await recoverStandaloneRun(w, RECORD as never, { ownerReplica: "r1", epoch: 1 } as never);

    expect(closed, "the adopted attempt was left reading as live work").toEqual([["a-verify", "committed"]]);
  });

  it("STAYS OWED when the store cannot say whether a half was staged", async () => {
    // Deciding either way from a failed read is how a verdict became a settled result in the first place: an
    // unreadable store is not a case with no agent half (rule `protocol` L2).
    const resumedWith: Array<unknown> = [];
    const halves = {
      put: async () => "ref",
      remove: async () => undefined,
      get: async () => {
        throw new Error("artifact store unavailable");
      },
    } as unknown as ReturnType<typeof staged>;
    const outcome = await recoverStandaloneRun(
      verifierWorld(resumedWith, halves),
      RECORD as never,
      {
        ownerReplica: "r1",
        epoch: 1,
      } as never,
    );

    expect(outcome.kind, "an unreadable store was read as 'there is no agent half'").toBe("retry_later");
    expect(resumedWith, "the run was settled on the strength of a read that failed").toHaveLength(0);
  });

  it("falls through to the re-drive when nothing was staged", async () => {
    // `absent` is the ordinary case for an older writer or a deployment with no artifact store: the agent's
    // evidence is genuinely gone, so the run re-drives exactly as it did before.
    const resumedWith: Array<unknown> = [];
    await recoverStandaloneRun(
      verifierWorld(resumedWith, staged(undefined)),
      RECORD as never,
      {
        ownerReplica: "r1",
        epoch: 1,
      } as never,
    );
    expect(resumedWith[0]).toBeUndefined();
  });
});

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

// ── …AND THE STAMP FOLLOWS THE SETTLEMENT (arch-review 62 follow-through) ────────────────────────────
//
// `committed` says this attempt's result IS the case's answer, and this lane wrote it BEFORE handing the
// result to `service.resume`. So a crash in between — or a resume that lost to a concurrent settlement —
// left the ledger claiming an answer the run never recorded.
//
// The batch path stopped making that statement when `commitCase` bound the receipt, the child's terminal
// write and the attempt stamp into one transaction (arch-review 43). This lane has no such transaction to
// join: the run store and the ledger settle through different calls. What it can do is stop asserting the
// stronger thing first — the residual window is now the reverse one, a settled run whose attempt row is
// still open, and that is the direction the sweep already handles because an open row is work it re-examines
// rather than a claim it believes.
//
// Seen RED before the reorder, observed:
//   an attempt claimed the case's answer while another settlement had already won: expected [ [ 'a-verify',
//   'committed' ] ] to deeply equal []
describe("[R62-followup COUNTEREXAMPLE] an adopted attempt is stamped only once the run took its result", () => {
  const world = (resume: () => ResumeResult) => {
    const closed: Array<[string, string]> = [];
    const halves = {
      put: async () => "ref",
      get: async () => new TextEncoder().encode(JSON.stringify(AGENT_HALF)),
      remove: async () => undefined,
    };
    const deps = {
      scorecardStore: { get: async () => undefined },
      store: { get: async () => RECORD },
      owner: "r1",
      replicas: { alive: async () => [] },
      scorecardService: { resume: async () => ({ kind: "resumed" }) },
      // The settlement is what stamps now, so this stands in for it: the outcome decides, and the id the
      // lane handed over is what would be stamped (arch-review 63 P1-high).
      service: {
        resume: async (_r: unknown, _adopted: unknown, _a: unknown, attemptId?: string) => {
          const outcome = resume();
          if (outcome.kind === "resumed" && attemptId !== undefined) closed.push([attemptId, "committed"]);
          return outcome;
        },
      },
      agentHalves: halves,
      attempts: {
        transition: async (id: string, to: string) => {
          closed.push([id, to]);
          return true;
        },
      },
      workHandlesFor: async () => [
        {
          tenant: "acme",
          runId: "evd-run-r1",
          externalJobId: "everdict-verify-c1",
          attemptId: "a-verify",
          verifier: {
            planDigest: "sha256:plan",
            workspaceDigest: AGENT_TREE,
            caseId: "c1",
            agentResultDigest: agentHalfDigest(AGENT_HALF),
          },
        },
      ],
      adoptWorkFn: async () => ({
        kind: "adopted",
        adopted: {
          stage: "verifier",
          invocation: {
            planDigest: "sha256:plan",
            workspaceDigest: AGENT_TREE,
            scores: [{ graderId: "reward-file", metric: "tests_pass", value: 1, pass: true }],
          },
        },
      }),
    } as unknown as Parameters<typeof recoverStandaloneRun>[0];
    return { deps, closed };
  };

  const recover = async (resume: () => ResumeResult) => {
    const { deps, closed } = world(resume);
    await recoverStandaloneRun(deps, RECORD as never, { ownerReplica: "r1", epoch: 1 } as never);
    return closed;
  };

  it("does NOT stamp it when another settlement already won", async () => {
    const closed = await recover(() => ({ kind: "already_settled", record: RECORD as never }));
    expect(closed, "an attempt claimed the case's answer while another settlement had already won").toEqual([]);
  });

  it("does NOT stamp it when the settlement decided nothing", async () => {
    // `retry_later` establishes nothing about the run, so it establishes nothing about the attempt either.
    const closed = await recover(() => ({ kind: "retry_later", reason: "the store would not answer" }));
    expect(closed, "an attempt was settled on the strength of a decision nobody made").toEqual([]);
  });

  it("DOES stamp it when the run recorded this result", async () => {
    // The control: a stamp that never fires would satisfy both assertions above and leave every recovered
    // attempt reading as live work — the defect arch-review 61 closed.
    const closed = await recover(() => ({ kind: "resumed" }));
    expect(closed, "a recovered attempt was left reading as live work").toEqual([["a-verify", "committed"]]);
  });
});

// ── A CRASH DELAYS AN OUTCOME, IT DOES NOT CHANGE WHAT WAS MEASURED (arch-review 63 P0) ─────────────
//
// A case is not finished when its containers are. The in-line path is
//
//     dispatch → collectDeferredTrace → settle
//
// and that middle step is where a `traceRef` case gets its platform trace pulled, its `sourceTraceId` and
// evidence recorded, its DEFERRED observation graders run and its trajectory sealed. The recovery handed the
// adopted result straight to the settle.
//
// So the same case, judged by the same containers, came out of a crash with a different trace, no deferred
// scores and no evidence — and nothing downstream can see the seam, because both are `CaseResult`s. That is
// not a slower answer; it is a different measurement, which is the one thing a recovery may never be.
//
// Seen RED before the completion travelled, observed:
//   a recovered case skipped the completion an in-line one runs: expected undefined to be 'collected'
describe("[R63 COUNTEREXAMPLE] a recovered case runs the completion an in-line one runs", () => {
  const recoverWith = async (completeRecovered?: unknown) => {
    const resumedWith: Array<unknown> = [];
    const halves = {
      put: async () => "ref",
      get: async () => new TextEncoder().encode(JSON.stringify(AGENT_HALF)),
      remove: async () => undefined,
    };
    const deps = {
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
      agentHalves: halves,
      ...(completeRecovered ? { completeRecovered } : {}),
      workHandlesFor: async () => [
        {
          tenant: "acme",
          runId: "evd-run-r1",
          externalJobId: "everdict-verify-c1",
          attemptId: "a-verify",
          verifier: {
            planDigest: "sha256:plan",
            workspaceDigest: AGENT_TREE,
            caseId: "c1",
            agentResultDigest: agentHalfDigest(AGENT_HALF),
          },
        },
      ],
      adoptWorkFn: async () => ({
        kind: "adopted",
        adopted: {
          stage: "verifier",
          invocation: {
            planDigest: "sha256:plan",
            workspaceDigest: AGENT_TREE,
            scores: [{ graderId: "reward-file", metric: "tests_pass", value: 1, pass: true }],
          },
        },
      }),
    } as unknown as Parameters<typeof recoverStandaloneRun>[0];
    // A record with a case spec, because the completion is about THIS case's declared graders and trace ref.
    const record = { ...RECORD, caseSpec: { id: "c1", task: "t", env: { kind: "prompt" }, graders: [] } };
    await recoverStandaloneRun(deps, record as never, { ownerReplica: "r1", epoch: 1 } as never);
    return resumedWith[0] as { harness?: string; sourceTraceId?: string } | undefined;
  };

  it("settles the COMPLETED result, not the raw merge", async () => {
    const settled = await recoverWith(async (_t: string, _c: unknown, result: Record<string, unknown>) => ({
      ...result,
      sourceTraceId: "collected",
    }));

    expect(settled?.sourceTraceId, "a recovered case skipped the completion an in-line one runs").toBe("collected");
    // …and it is still the agent's own document underneath, or the completion has replaced the case.
    expect(settled?.harness).toBe("agent@1");
  });

  it("settles the merge unchanged when this deployment defers no collection", async () => {
    // The ordinary case: no completion wired means no deferred collection, which is a real configuration and
    // not a silent difference.
    const settled = await recoverWith(undefined);
    expect(settled?.harness).toBe("agent@1");
    expect(settled?.sourceTraceId).toBeUndefined();
  });

  it("keeps the result when the completion FAILS — parity must not cost the case", async () => {
    // A collection that cannot reach the platform is a retryable failure `collectDeferredTrace` records on
    // the result itself; refusing the whole recovery over it would trade a real verdict for a trace pull.
    const settled = await recoverWith(async () => {
      throw new Error("the trace platform is unreachable");
    });
    expect(settled?.harness, "a completion failure cost the recovery a result it already had").toBe("agent@1");
  });
});
