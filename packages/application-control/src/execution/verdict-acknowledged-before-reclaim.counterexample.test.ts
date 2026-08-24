import type { VerifierInvocation, VerifierJob } from "@everdict/contracts";
import { VerifierInvocationSchema } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryExecutionAttemptStore } from "../ports/execution-attempt-store.js";
import type { AgentHalfStore } from "./agent-half.js";
import { type VerifierDispatchHooks, verifierOperation } from "./verifier-operation.js";

// ── THE DURABLE HANDOVER PRECEDES THE EXTERNAL CLEANUP (arch-review 66 P0-lifecycle) ───────────────
//
// Every managed lane reads its container's logs, builds the invocation, and reclaims the object in a
// `finally` — and only THEN does the returned value reach `verifierOperation`, which canonicalizes and
// stages it. So the ordinary shape of a crash was:
//
//     verifier logs parsed → verifier Job deleted → ✗ → the verdict is gone
//
// A constitutional decision that had already been computed and paid for was tied to the lifetime of the
// process holding it, with the container that could have re-produced it already destroyed. The bytes being
// durable "soon after" is not the property; the property is that they are durable BEFORE the thing that
// produced them stops existing.
//
// `hooks.acknowledge` is that seam: the lane calls it inside its try, gets the CANONICAL document back, and
// its cleanup runs afterwards. This drives the operation with a lane that records the exact order.
//
// Seen RED with the stage left where it was (after the lane returns), observed:
//   the verdict was not durable until after its container had been reclaimed: expected [ 'reclaim', 'staged' ] to deeply equal [ 'staged', 'reclaim' ]

const RUN = "evd-run-r1";

const JOB: VerifierJob = {
  runId: RUN,
  tenant: "acme",
  caseId: "c1",
  workdir: "/app",
  workspace: { kind: "repo", diff: "", changedFiles: [], base: "b", headSha: "h" },
  plan: { digest: "sha256:plan", graders: [] },
  timeoutSec: 60,
  agentResultDigest: "sha256:half",
  agentAttemptId: `${RUN}#g1`,
} as unknown as VerifierJob;

const RAW: VerifierInvocation = VerifierInvocationSchema.parse({
  planDigest: "sha256:plan",
  workspaceDigest: "sha256:tree",
  scores: [{ graderId: "reward-file", metric: "tests_pass", value: 1, pass: true }],
  imageProvenance: { kind: "resolved", images: [{ ref: "v:1", digest: "sha256:i" }], by: "orchestrator" },
});

// An object store that records WHEN it was written, so the ordering is observable rather than asserted.
function recordingStore(order: string[]): AgentHalfStore {
  return {
    async put(key: string) {
      order.push("staged");
      return key;
    },
    async get() {
      return undefined;
    },
    async remove() {
      order.push("removed");
    },
  };
}

// A managed lane in the shape both real ones have: parse, hand over, and reclaim in a `finally` that runs
// whichever way the block leaves.
const laneThatReclaims =
  (order: string[], opts: { acknowledge: boolean }) =>
  async (job: VerifierJob, hooks: VerifierDispatchHooks): Promise<VerifierInvocation> => {
    const work = { tenant: job.tenant, runId: job.runId, externalJobId: "everdict-verify-c1" };
    await hooks.authority.reserve(work);
    await hooks.authority.activate(work);
    try {
      order.push("parsed");
      return opts.acknowledge && hooks.acknowledge ? await hooks.acknowledge(RAW) : RAW;
    } finally {
      order.push("reclaim");
    }
  };

describe("[R66 COUNTEREXAMPLE] a verdict is durable before its container is reclaimed", () => {
  it("STAGES before the lane's cleanup runs", async () => {
    const order: string[] = [];
    const attempts = new InMemoryExecutionAttemptStore();
    const verdicts = recordingStore(order);

    await verifierOperation({ attempts, verdicts }, JOB, laneThatReclaims(order, { acknowledge: true }));

    expect(
      order.filter((step) => step === "staged" || step === "reclaim"),
      "the verdict was not durable until after its container had been reclaimed",
    ).toEqual(["staged", "reclaim"]);
  });

  it("hands the lane back the CANONICAL document, not a second version of it", async () => {
    // The other half of the seam. If the acknowledgement returned nothing, a lane keeping its own copy would
    // hold the raw wire while the operation returned the canonical one — which is exactly the divergence
    // arch-review 65 closed one layer up, re-opened by the fix for this one.
    const order: string[] = [];
    const attempts = new InMemoryExecutionAttemptStore();
    let handedBack: VerifierInvocation | undefined;

    const returned = await verifierOperation({ attempts, verdicts: recordingStore(order) }, JOB, async (job, hooks) => {
      const work = { tenant: job.tenant, runId: job.runId, externalJobId: "everdict-verify-c1" };
      await hooks.authority.reserve(work);
      await hooks.authority.activate(work);
      handedBack = hooks.acknowledge ? await hooks.acknowledge(RAW) : RAW;
      return handedBack;
    });

    expect(handedBack, "the lane got nothing back, so it would keep the raw wire").toBeDefined();
    expect(handedBack, "the lane's document and the operation's document are two different objects").toEqual(returned);
    expect(returned.work?.attemptId, "the canonical join did not happen before the handover").toBeDefined();
    expect(returned.agentAttemptId).toBe(`${RUN}#g1`);
  });

  it("still finishes for a lane that does NOT acknowledge — the old ordering, stated", async () => {
    // Both lanes learned this together, and a third (a self-hosted runner, a future orchestrator) may not
    // have. Such a lane keeps exactly what it had: a verdict staged after its container is gone. What it must
    // not do is fail, and what this repo must not do is claim the property for it.
    const order: string[] = [];
    const attempts = new InMemoryExecutionAttemptStore();

    const returned = await verifierOperation(
      { attempts, verdicts: recordingStore(order) },
      JOB,
      laneThatReclaims(order, { acknowledge: false }),
    );

    expect(returned.work?.attemptId, "an unacknowledging lane lost its canonical join").toBeDefined();
    expect(
      order.filter((s) => s === "staged" || s === "reclaim"),
      "this lane is not on the old ordering",
    ).toEqual(["reclaim", "staged"]);
  });
});
