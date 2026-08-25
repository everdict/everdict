import type { VerifierInvocation, VerifierJob } from "@everdict/contracts";
import { VerifierInvocationSchema } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { DispatchOptions } from "../ports/dispatcher.js";
import { InMemoryExecutionAttemptStore } from "../ports/execution-attempt-store.js";
import type { AgentHalfStore } from "./agent-half.js";
import { type VerifierDispatchHooks, verifierOperation } from "./verifier-operation.js";
import { withVerifierPass } from "./verifier-pass.js";

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

  it("REFUSES the acknowledgement when the write did not land, under `required`", async () => {
    // ⚠️ THE ORDERING WAS RIGHT AND THE GUARANTEE WAS EMPTY (arch-review 67 P0-lifecycle). The first version
    // of the acknowledgement wrapped its store write in `.catch(() => undefined)` and then reported success,
    // so a verdict store that threw produced a successful handover, the lane deleted its Job, and a crash
    // before settlement lost a decision that had already been computed — with the container that could have
    // re-produced it already gone.
    //
    // Under `required`, the failure propagates OUT of the acknowledgement and the operation refuses — so the
    // case ends `unmeasured` upstream instead of being recorded as judged over bytes that do not exist.
    //
    // ⚠️ WHAT IT DOES NOT BUY, STATED RATHER THAN CLAIMED: the container is still reclaimed. Both lanes put
    // their cleanup in a `finally`, which runs on the throw path too, so keeping the object for inspection
    // would mean restructuring every backend's failure-path reclaim — and a `finally` that stops running on
    // some errors is how objects leak. `required` means "no verdict this deployment cannot recover is ever
    // recorded as one"; it does not mean the container survives (rule `protocol`: claiming the stronger
    // property without the mechanism is the failure).
    const order: string[] = [];
    const attempts = new InMemoryExecutionAttemptStore();
    const unwritable: AgentHalfStore = {
      async put() {
        order.push("write-failed");
        throw new Error("the verdict store is unreachable");
      },
      async get() {
        return undefined;
      },
      async remove() {},
    };

    const outcome = await verifierOperation(
      { attempts, verdicts: unwritable, durability: "required" },
      JOB,
      laneThatReclaims(order, { acknowledge: true }),
    ).then(
      () => "returned" as const,
      () => "refused" as const,
    );

    expect(outcome, "an unwritable verdict was acknowledged as durable").toBe("refused");
    // The write really was attempted and really did fail — without this the refusal could be coming from
    // anywhere.
    expect(order, "the stage was never reached, so this case measures something else").toContain("write-failed");
  });

  it("KEEPS the verdict under `best_effort`, and says the deployment chose that", async () => {
    // The control, and the reason this is a declared policy rather than a hardening: availability first is a
    // legitimate choice, and it is what every caller had before the seam existed. What it must not be is the
    // SILENT default of a system claiming crash-safety.
    const order: string[] = [];
    const attempts = new InMemoryExecutionAttemptStore();
    const unwritable: AgentHalfStore = {
      async put() {
        throw new Error("the verdict store is unreachable");
      },
      async get() {
        return undefined;
      },
      async remove() {},
    };

    const returned = await verifierOperation(
      { attempts, verdicts: unwritable, durability: "best_effort" },
      JOB,
      laneThatReclaims(order, { acknowledge: true }),
    );

    expect(returned.scores, "an availability-first deployment lost a verdict it had in hand").toEqual(RAW.scores);
    expect(order, "the lane did not reclaim, so this is not the best-effort path").toContain("reclaim");
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
// ── AND THE AGENT'S HALF, ON THE LANE THAT WAS LEFT (arch-review 67 P0-lifecycle) ──────────────────
//
// arch-review 66 gave the verifier this seam and left the agent's — the one-lane-only shape again. Every
// managed backend reclaims its object in a `finally`, so staging the half after the dispatch RESOLVED meant
// a crash there lost a completed agent execution whose container was already gone.
//
// ⚠️ AND IT MUST NOT STAGE FOR A VERIFIER THAT WILL NEVER RUN. A half written for a refused case is garbage
// the moment it is written (arch-review 62), so the acknowledgement decides that first — from the lane's
// presence, the tenant/run coordinate and the snapshot on the result it is handed.
//
// Seen RED with the stage left after the dispatch, observed:
//   the agent half was not durable until after its container had been reclaimed: expected [ 'reclaim', 'staged' ] to deeply equal [ 'staged', 'reclaim' ]
describe("[R67 COUNTEREXAMPLE] the agent's half is durable before its container is reclaimed", () => {
  const AGENT_JOB = {
    tenant: "acme",
    runId: RUN,
    harness: { id: "h", version: "1" },
    evalCase: {
      id: "c1",
      task: "t",
      env: { kind: "repo", source: { path: "/app" } },
      graders: [{ id: "reward-file", config: { files: { "tests/test.sh": "exit 0" } } }],
      timeoutSec: 60,
      tags: [],
    },
  } as never;

  const AGENT_RESULT = {
    caseId: "c1",
    harness: "h@1",
    trace: [],
    scores: [],
    snapshot: { kind: "repo", diff: "", changedFiles: [], base: "b", headSha: "h" },
  } as never;

  // A managed lane in the shape both real ones have: parse, hand over, reclaim in a `finally`.
  const agentLane = (order: string[], acknowledge: boolean) => async (_job: never, opts?: DispatchOptions) => {
    try {
      order.push("parsed");
      return acknowledge && opts?.acknowledgeResult ? await opts.acknowledgeResult(AGENT_RESULT) : AGENT_RESULT;
    } finally {
      order.push("reclaim");
    }
  };

  it("STAGES before the lane's cleanup runs", async () => {
    const order: string[] = [];
    const halves: AgentHalfStore = {
      async put(key: string) {
        order.push("staged");
        return key;
      },
      async get() {
        return undefined;
      },
      async remove() {},
    };

    await withVerifierPass(AGENT_JOB, {
      dispatch: agentLane(order, true),
      agentHalves: halves,
      dispatchVerifier: async () => {
        throw new Error("the verifier container crashed");
      },
    } as never);

    expect(
      order.filter((step) => step === "staged" || step === "reclaim"),
      "the agent half was not durable until after its container had been reclaimed",
    ).toEqual(["staged", "reclaim"]);
  });

  it("stages NOTHING when no verifier will run", async () => {
    // The control that keeps this from re-opening arch-review 62: a half for a verifier that is never
    // dispatched is garbage on arrival, and the acknowledgement has everything it needs to know that.
    const order: string[] = [];
    const halves: AgentHalfStore = {
      async put(key: string) {
        order.push("staged");
        return key;
      },
      async get() {
        return undefined;
      },
      async remove() {},
    };

    await withVerifierPass(AGENT_JOB, { dispatch: agentLane(order, true), agentHalves: halves } as never);

    expect(order, "a half was staged for a verifier this deployment cannot run").not.toContain("staged");
  });
});
