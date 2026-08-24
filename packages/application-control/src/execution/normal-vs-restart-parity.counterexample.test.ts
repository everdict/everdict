import type { CaseJob, CaseResult, RuntimeWorkRef, VerifierInvocation, VerifierJob } from "@everdict/contracts";
import { CaseResultSchema, VerifierInvocationSchema, storedExecutionId } from "@everdict/contracts";
import { caseObservationDigest, caseResultDigest, contentDigest, verifierPlanOf } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import { InMemoryExecutionAttemptStore } from "../ports/execution-attempt-store.js";
import { InMemoryIntermediateCleanupStore } from "../ports/intermediate-cleanup-store.js";
import { type AgentHalfStore, recoverStagedVerdict } from "./agent-half.js";
import { withVerifierPass } from "./verifier-pass.js";

// ── ONE EXECUTION, ONE DOCUMENT, WHATEVER THE PROCESS DID (arch-review 66 P1-high) ──────────────────
//
// A crash must change the TIMING of a case's answer and nothing else. It changed the answer: the normal path
// attached `CaseResult.intermediates` (the GC coordinate arch-review 65 added) and the recovery path did not,
// so the same agent bytes and the same verdict produced different documents — and therefore different
// `caseResultDigest` AND `caseObservationDigest`.
//
// The observation digest is the one that stings. It exists to say "the same thing was observed", and it is
// what a metamorphic check, a re-score parity gate and a receipt comparison all rest on. Lifecycle metadata
// inside it makes one measurement read as two experiments.
//
// ⚠️ THE EXISTING DURABILITY FILE CANNOT SEE THIS, and the reason is the rule: it compares
// `recoverStagedVerdict` against `recoverVerifiedCase` — two HELPERS, neither of which is the normal path.
// Whatever `withVerifierPass` adds on top is invisible to both sides of that comparison. Parity is asserted
// between what production actually RUNS (rule `testing`).
//
// Seen RED before the coordinate moved off the document, observed:
//   a crash changed the case's own document: expected { …, intermediates: {…} } to deeply equal { … }

const RUN = "evd-run-r1";
const EXECUTION = storedExecutionId(RUN);

const JOB: CaseJob = {
  tenant: "acme",
  runId: RUN,
  harness: { id: "h", version: "1" },
  // WHICH physical agent execution this is. Production always has one, and `VerifierReceipt.complete` needs
  // it alongside the verifier's own attempt — without it both paths report an INCOMPLETE receipt and the
  // parity assertion below would be comparing two degraded documents rather than two good ones.
  attemptId: `${EXECUTION}#g1`,
  evalCase: {
    id: "c1",
    task: "t",
    env: { kind: "repo", source: { path: "/app" } },
    // PRIVATE by its config carrying material the agent must not see — what makes a verifier plan at all.
    graders: [{ id: "reward-file", config: { files: { "tests/test.sh": "exit 0" } } }],
    timeoutSec: 60,
    tags: [],
  },
} as unknown as CaseJob;

// PARSED, because the recovery reads the staged half back through `CaseResultSchema` and `mergeVerifierPass`
// compares `contentDigest(snapshot)` on both sides. A raw literal digests differently from its own parsed
// form, and the merge then refuses for "a different workspace" — a red with nothing to do with parity.
const AGENT_RESULT: CaseResult = CaseResultSchema.parse({
  caseId: "c1",
  harness: "h@1",
  trace: [{ t: 0, kind: "log", stream: "stdout", text: "the agent ran" }],
  scores: [{ graderId: "steps", metric: "steps", value: 7 }],
  snapshot: { kind: "repo", diff: "diff --git a/x b/x", changedFiles: [], base: "b", headSha: "h" },
});

// The plan digest comes from the PRODUCTION planner, not a literal: the reservation stamps
// `verifierPlanOf(evalCase).digest` onto the handle, and the recovery refuses a staged verdict whose plan
// disagrees with it. A hand-picked string makes the recovery answer `unknown` for a reason that has nothing
// to do with parity — which is exactly how the first draft of this file went red.
const PLAN_DIGEST = verifierPlanOf(JOB.evalCase)?.digest;
if (PLAN_DIGEST === undefined) throw new Error("this fixture's case declares no verifier plan, so it tests nothing");

const VERDICT: VerifierInvocation = VerifierInvocationSchema.parse({
  planDigest: PLAN_DIGEST,
  workspaceDigest: contentDigest(AGENT_RESULT.snapshot),
  scores: [{ graderId: "reward-file", metric: "tests_pass", value: 1, pass: true }],
  imageProvenance: { kind: "resolved", images: [{ ref: "verifier:1", digest: "sha256:img" }], by: "orchestrator" },
});

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

// THE NORMAL PATH, exactly as production runs it: `withVerifierPass` over a lane that reserves, activates and
// answers. The reservation is what joins the canonical coordinates, so the same operation runs both times.
async function normalPath() {
  const artifacts = artifactStore();
  const attempts = new InMemoryExecutionAttemptStore();
  const cleanup = new InMemoryIntermediateCleanupStore();
  let handle: RuntimeWorkRef | undefined;

  const result = await withVerifierPass(JOB, {
    dispatch: async () => AGENT_RESULT,
    agentHalves: artifacts,
    verdicts: artifacts,
    attempts,
    cleanup,
    dispatchVerifier: async (job: VerifierJob) => {
      // The verifier operation the composition root wires — opened, reserved, activated, then answered.
      const { verifierOperation } = await import("./verifier-operation.js");
      return await verifierOperation({ attempts, verdicts: artifacts }, job, async (j, hooks) => {
        const work = { tenant: j.tenant, runId: j.runId, externalJobId: "everdict-verify-c1" };
        const intent = await hooks.authority.reserve(work);
        await hooks.authority.activate(work);
        handle = intent.work;
        return VERDICT;
      });
    },
  } as never);

  if (!handle) throw new Error("the lane reserved no handle, so the restart below has nothing to recover from");
  return { result, artifacts, handle };
}

describe("[R66 COUNTEREXAMPLE] a crash changes when a case is answered, never what the answer is", () => {
  it("produces a BYTE-IDENTICAL document and both digests across a restart", async () => {
    const inline = await normalPath();

    // The restart: the process is gone, both containers are reclaimed, and only the object store survives.
    const recovered = await recoverStagedVerdict(inline.artifacts, inline.artifacts, "acme", RUN, inline.handle);
    expect(recovered.kind, "the recovery could not finish the case at all, so parity is untested").toBe("merged");
    if (recovered.kind !== "merged") return;

    expect(recovered.result, "a crash changed the case's own document").toEqual(inline.result);
    expect(caseResultDigest(recovered.result), "a crash changed the case's result digest").toBe(
      caseResultDigest(inline.result),
    );
    expect(
      caseObservationDigest(recovered.result),
      "a crash changed what the case OBSERVED — one measurement now reads as two experiments",
    ).toBe(caseObservationDigest(inline.result));
    // …and the receipt is complete on both sides, which is the property arch-review 65's canonical join buys.
    expect(recovered.result.verifier?.complete).toBe(true);
    expect(inline.result.verifier?.complete).toBe(true);
  });

  it("keeps platform lifecycle state OFF the document on both paths", async () => {
    // The trust-domain half. `submit_job_result` parses a self-hosted runner's JSON with this very schema, so
    // a field here is a field a workspace-controlled runner can set — and the settlement reads it to decide
    // which objects to delete.
    const inline = await normalPath();
    const recovered = await recoverStagedVerdict(inline.artifacts, inline.artifacts, "acme", RUN, inline.handle);
    if (recovered.kind !== "merged") throw new Error("not merged");

    for (const [label, doc] of [
      ["the normal path", inline.result],
      ["the recovery path", recovered.result],
    ] as const)
      expect(
        (doc as unknown as Record<string, unknown>).intermediates,
        `${label} put platform cleanup state on the measurement document`,
      ).toBe(undefined);
  });

  it("still OWES the staged bytes — the debt moved, it did not disappear", async () => {
    // The control that keeps this change from being a silent regression of arch-review 65: taking the
    // coordinate off the document must not take the cleanup with it.
    const artifacts = artifactStore();
    const attempts = new InMemoryExecutionAttemptStore();
    const cleanup = new InMemoryIntermediateCleanupStore();
    await withVerifierPass(JOB, {
      dispatch: async () => AGENT_RESULT,
      agentHalves: artifacts,
      verdicts: artifacts,
      attempts,
      cleanup,
      dispatchVerifier: async (): Promise<VerifierInvocation> => VERDICT,
    } as never);

    const owed = await cleanup.owed("acme", EXECUTION);
    expect(owed.length, "the staged half is owed to nobody now that the document does not carry it").toBe(1);
    expect(owed[0]?.key).toBe(artifacts.keys().find((k) => k.startsWith("agent-half/")));
  });
});
