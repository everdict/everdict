import type { CaseJob, CaseResult, VerifierInvocation } from "@everdict/contracts";
import { contentDigest } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import { InMemoryIntermediateCleanupStore } from "../ports/intermediate-cleanup-store.js";
import type { AgentHalfStore } from "./agent-half.js";
import { withVerifierPass } from "./verifier-pass.js";

// ── A CALLBACK THAT RAN IS NOT BYTES THAT LANDED (arch-review 70 P0-lifecycle) ──────────────────────
//
// arch-review 67 moved the agent handover to the right MOMENT and arch-review 69 made the Scheduler carry
// it, so in production the backend now hands its parsed result over BEFORE the `finally` that reclaims the
// container. The ordering is correct. The guarantee was still empty:
//
//     await stageAgentHalf(...);   // Promise<void>, ending `.catch(() => undefined)`
//     stagedEarly = true;          // proves the FUNCTION was called
//
// So a put or a confirm that failed produced a successful acknowledgement, a reclaimed Job, a verifier
// running against a digest whose bytes do not exist — and because `stagedEarly` gates the fallback, no
// second attempt to stage either. A crash before settlement then loses a completed agent execution whose
// container is already gone.
//
// ⚠️ THE SAME FILE ALREADY CONTAINED THE FIX, 120 LINES DOWN. `stageVerifierVerdict` returns
// `VerdictStageOutcome` and deliberately does not swallow; arch-review 67 wrote that for the verdict and
// left the agent half exactly as it was. Sibling-lane, eighth occurrence (58 · 59 · 61 · 64 · 66 · 67 · 69 ·
// 70) and the shortest distance yet — proximity does not transfer a law.
//
// Seen RED before the stage returned an outcome, observed:
//   a failed stage was reported as a durable handover: expected undefined to be 'absent'
//   the fallback was skipped after a stage that wrote nothing: expected 1 to be 2

const JOB = {
  tenant: "acme",
  runId: "evd-run-r1",
  harness: { id: "h", version: "1" },
  evalCase: {
    id: "c1",
    task: "t",
    env: { kind: "repo", source: { path: "/app" } },
    graders: [{ id: "reward-file", config: { files: { "tests/test.sh": "exit 0" } } }],
    timeoutSec: 60,
  },
} as unknown as CaseJob;

const SNAPSHOT = { kind: "repo", diff: "", changedFiles: [], headSha: "h" } as const;

const RESULT = {
  caseId: "c1",
  harness: "h@1",
  trace: [],
  snapshot: SNAPSHOT,
  scores: [],
} as unknown as CaseResult;

const verdict = async (): Promise<VerifierInvocation> => ({
  planDigest: "sha256:plan",
  workspaceDigest: contentDigest(SNAPSHOT),
  scores: [{ graderId: "reward-file", metric: "tests_pass", value: 1, pass: true }],
});

// A store whose PUT fails, which is the whole point: `owe` lands, the bytes do not, and the question is what
// the acknowledgement then reports to a caller that is about to destroy the only other copy.
function refusingStore(attempts: { count: number }): AgentHalfStore {
  return {
    async put() {
      attempts.count += 1;
      throw new Error("the object store refused the write");
    },
    async get() {
      return undefined;
    },
    async remove() {
      // nothing is ever collected here
    },
  };
}

// The managed lane's shape: hand the result over inside the try, reclaim in the `finally` whatever happened.
const managedDispatch =
  (order: string[]) => async (_job: CaseJob, opts?: { acknowledgeResult?: (r: CaseResult) => Promise<CaseResult> }) => {
    try {
      return opts?.acknowledgeResult ? await opts.acknowledgeResult(RESULT) : RESULT;
    } finally {
      order.push("reclaim");
    }
  };

describe("[R70 COUNTEREXAMPLE] the agent handover proves durability, not execution", () => {
  it("does NOT report a durable handover when the bytes were refused", async () => {
    const attempts = { count: 0 };
    const cleanup = new InMemoryIntermediateCleanupStore();

    const result = await withVerifierPass(JOB, {
      dispatch: managedDispatch([]),
      dispatchVerifier: verdict,
      agentHalves: refusingStore(attempts),
      cleanup,
    } as never);

    // The case still produces a result — best_effort is the default and a storage fault must not cost a
    // measurement. What must NOT happen is the pass believing it staged something.
    expect(result.caseId).toBe("c1");
    // The debt is owed (recorded before the put, deliberately) and NOT confirmed: nothing may read this ref
    // as bytes that exist.
    const refs = cleanup.snapshot().flatMap((d) => d.refs);
    expect(refs, "the debt was not recorded before the put").toHaveLength(1);
    expect(
      refs[0]?.written,
      "a ref whose put threw was marked written, so a sweep would delete an absent key and call the debt paid",
    ).not.toBe(true);
  });

  it("still RETRIES at the fallback, because nothing was staged early", async () => {
    // `stagedEarly` gated the fallback on "the function was called" rather than "the bytes are there", so a
    // failed early stage silently removed the second chance the non-acknowledging lanes still have.
    const attempts = { count: 0 };

    await withVerifierPass(JOB, {
      dispatch: managedDispatch([]),
      dispatchVerifier: verdict,
      agentHalves: refusingStore(attempts),
      cleanup: new InMemoryIntermediateCleanupStore(),
    } as never);

    expect(attempts.count, "the fallback was skipped after a stage that wrote nothing").toBe(2);
  });

  it("REFUSES the acknowledgement under required durability", async () => {
    // The trade, stated where it is made. A deployment that treats the private verifier as constitutional
    // evidence cannot let a lane reclaim its container over bytes that do not exist — so the acknowledgement
    // throws, the lane never reaches its cleanup, and the case fails honestly instead of succeeding over a
    // recovery it does not have.
    const failed = await withVerifierPass(JOB, {
      dispatch: managedDispatch([]),
      dispatchVerifier: verdict,
      agentHalves: refusingStore({ count: 0 }),
      cleanup: new InMemoryIntermediateCleanupStore(),
      durability: "required",
    } as never).then(
      (r) => r,
      (e: unknown) => e,
    );

    expect(failed, "a required deployment accepted a handover whose bytes were refused").toBeInstanceOf(Error);
  });

  it("reports a durable handover when the bytes DID land, and stages exactly once", async () => {
    // The control: the ordinary path must keep exactly the behaviour it has, or this fix has bought
    // correctness by making every case pay twice.
    const puts: string[] = [];
    const cleanup = new InMemoryIntermediateCleanupStore();
    const store: AgentHalfStore = {
      async put(key: string) {
        puts.push(key);
        return key;
      },
      async get() {
        return undefined;
      },
      async remove() {},
    };

    await withVerifierPass(JOB, {
      dispatch: managedDispatch([]),
      dispatchVerifier: verdict,
      agentHalves: store,
      cleanup,
    } as never);

    expect(puts, "the ordinary path staged more than once").toHaveLength(1);
    expect(
      cleanup.snapshot().flatMap((d) => d.refs)[0]?.written,
      "a landed write was never confirmed, so the sweep can never collect it",
    ).toBe(true);
  });
});
