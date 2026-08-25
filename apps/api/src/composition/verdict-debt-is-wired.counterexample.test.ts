import { InMemoryExecutionAttemptStore, InMemoryIntermediateCleanupStore } from "@everdict/application-control";
import type { VerifierInvocation, VerifierJob } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { buildRuntimeAccess } from "./runtime-access.js";

// ── ONE FEATURE, TWO HALVES, AND ONLY ONE OF THEM WIRED (arch-review 69 P1) ─────────────────────────
//
// `stageVerifierVerdict` records the verdict's cleanup debt when it is handed a ledger, and
// `VerifierOperationDeps` declares the field for exactly that. The production composition never passed one:
// `buildRuntimeAccess` had no `cleanup` in its deps at all, so the spread was `undefined` on every dispatch.
//
// The AGENT half's lane did have it — `VerifierAwareDispatcher`'s fifth constructor argument, added in
// arch-review 67. So a normally-completing private-verifier case ended like this:
//
//     agent-half/…        bytes written   ledger row written   settlement deletes it
//     verifier-verdict/…  bytes written   NO ROW               nothing can ever find it
//
// The settlement discharges what the ledger names, and the reconciler's worklist IS the ledger, so the
// verdict object is permanent — one per completed case, forever. Not a lost decision; a leak that nothing in
// the system is able to observe, which is worse to diagnose.
//
// ⚠️ THE SIBLING-LANE SHAPE, FOR THE SEVENTH TIME (58, 59, 61, 64, 66, 67, 69) — and the first where the two
// lanes are the two halves of the very feature being wired. Rule `protocol` says to grep for every other
// caller of a method whose contract changed and count them in the commit message. Two is the default.
//
// ⚠️ AND `pnpm unwired-capabilities` CANNOT SEE THIS. That scanner asks whether a producer EXISTS — whether
// some composition root constructs an implementation of the port — and `persistence.ts` constructs both, so
// it passes. What it does not ask is whether the producer REACHES every consumer that declares the dep
// optional. That is the gap this file covers, and it is why the check and the test are different shapes.
//
// Seen RED before `cleanup` reached the composition, observed:
//   the verdict was staged with no debt recording it: expected [] to have a length of 1
const JOB = {
  runId: "evd-run-r1",
  tenant: "acme",
  caseId: "c1",
  workdir: "/app",
  workspace: { kind: "repo", diff: "d", changedFiles: ["a"], headSha: "sha" },
  plan: { digest: "sha256:plan", graders: [{ id: "reward-file" }] },
  timeoutSec: 60,
  placementTarget: "rt-1",
  // Which half this verdict is about. Without it `stageVerifierVerdict` answers `absent` — there is no
  // coordinate to key a verdict by — and the test would measure that instead of the wiring.
  agentResultDigest: "sha256:the-half-that-was-judged",
} as unknown as VerifierJob;

const INVOCATION: VerifierInvocation = {
  planDigest: "sha256:plan",
  workspaceDigest: "sha256:workspace",
  scores: [{ graderId: "reward-file", metric: "tests_pass", value: 1, pass: true }],
};

// A lane that judges: it reserves its work like every real one (a fake that skips the reservation is more
// permissive than any backend, and the verdict it returns is one nothing can attribute — arch-review 62) and
// answers an invocation.
const judgingBackend = {
  async dispatchVerifier(_job: VerifierJob, hooks: { authority: { reserve: (w: unknown) => Promise<unknown> } }) {
    await hooks.authority.reserve({ tenant: "acme", runId: "evd-run-r1", externalJobId: "everdict-verify-1" });
    return INVOCATION;
  },
  async capacity() {
    return { total: 4, used: 0 };
  },
};

function objectStore(keys: string[]) {
  return {
    async put(key: string) {
      keys.push(key);
      return key;
    },
    async get() {
      return undefined;
    },
    async remove() {
      // this test never collects
    },
  };
}

describe("[R69 COUNTEREXAMPLE] the verdict's cleanup debt reaches the ledger from the composition root", () => {
  it("owes the verifier-verdict object it just wrote", async () => {
    const cleanup = new InMemoryIntermediateCleanupStore();
    const written: string[] = [];
    const { dispatchVerifier } = buildRuntimeAccess({
      runtimeRegistry: { get: async () => ({ id: "rt-1", kind: "local" }), list: async () => [] } as never,
      runtimeSecretsFor: async () => ({}),
      runtimeBuildBackend: () => judgingBackend as never,
      attempts: new InMemoryExecutionAttemptStore(),
      verdicts: objectStore(written),
      cleanup,
    } as never);

    await dispatchVerifier(JOB);

    expect(
      written.filter((k) => k.startsWith("verifier-verdict/")),
      "no verdict was staged at all",
    ).toHaveLength(1);
    const owed = cleanup.snapshot().flatMap((d) => d.refs.map((r) => r.key));
    expect(owed, "the verdict was staged with no debt recording it").toHaveLength(1);
    expect(owed[0], "the debt names something other than the object that was written").toBe(written[0]);
  });

  it("owes it under the EXECUTION, which is the coordinate the settlement discharges by", async () => {
    // The debt has to be findable by the thing that ends the case. A row keyed by anything else is a row the
    // settlement walks straight past — the agent half learned this in arch-review 68 and the verdict rides
    // the same key.
    const cleanup = new InMemoryIntermediateCleanupStore();
    const { dispatchVerifier } = buildRuntimeAccess({
      runtimeRegistry: { get: async () => ({ id: "rt-1", kind: "local" }), list: async () => [] } as never,
      runtimeSecretsFor: async () => ({}),
      runtimeBuildBackend: () => judgingBackend as never,
      attempts: new InMemoryExecutionAttemptStore(),
      verdicts: objectStore([]),
      cleanup,
    } as never);

    await dispatchVerifier(JOB);

    expect(cleanup.snapshot().map((d) => d.executionId)).toEqual(["evd-run-r1"]);
    // RETAINED: the case has not settled, so no sweep may touch these bytes yet.
    expect(
      cleanup.snapshot().map((d) => d.state),
      "a verdict was collectable before its case settled",
    ).toEqual(["retained"]);
  });

  it("still judges for a deployment that wired no ledger", async () => {
    // The control. `cleanup` is optional because a deployment may legitimately have none, and such a lane
    // must keep producing verdicts — the absent ledger costs the CLEANUP, never the decision.
    const written: string[] = [];
    const { dispatchVerifier } = buildRuntimeAccess({
      runtimeRegistry: { get: async () => ({ id: "rt-1", kind: "local" }), list: async () => [] } as never,
      runtimeSecretsFor: async () => ({}),
      runtimeBuildBackend: () => judgingBackend as never,
      attempts: new InMemoryExecutionAttemptStore(),
      verdicts: objectStore(written),
    } as never);

    const invocation = await dispatchVerifier(JOB);

    expect(invocation.scores, "a ledger-less deployment stopped producing verdicts").toHaveLength(1);
    expect(written).toHaveLength(1);
  });
});
