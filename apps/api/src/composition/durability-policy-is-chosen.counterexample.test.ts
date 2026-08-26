import { InMemoryExecutionAttemptStore, InMemoryIntermediateCleanupStore } from "@everdict/application-control";
import type { VerifierInvocation, VerifierJob } from "@everdict/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { assertVerifierDurabilitySatisfiable, verifierDurabilityFromEnv } from "./env-policy.js";
import { buildRuntimeAccess } from "./runtime-access.js";

// ── A POLICY THAT EXISTS IS NOT A POLICY THE DEPLOYMENT CHOSE (arch-review 70 P0-lifecycle) ─────────
//
// `VerifierDurabilityPolicy` shipped in arch-review 67 so a deployment could declare what it loses when a
// two-phase case's artifacts cannot be written. For two waves no composition root passed it: grep for
// `durability` across production `apps/api` returned four unrelated comments, so `verifierOperation` always
// saw `undefined` and took `best_effort`, and `required` existed only inside tests.
//
//     the policy type exists   ≠   this deployment selected a policy
//
// That is worse than a missing producer, because the DEFAULT stood in for the decision and the default is
// the permissive arm: a verdict store that threw became `absent`, the acknowledgement succeeded, the Job was
// reclaimed, and a crash before settlement lost a constitutional decision already computed.
//
// Two sentences that cannot both be true, and the repository was asserting both: "a private verifier verdict
// is constitutional evidence" and "a failed verdict artifact continues as an ordinary success".
//
// Seen RED before the composition passed a policy, observed:
//   a required deployment accepted a verdict whose bytes were refused: expected [Function] to throw

const JOB = {
  runId: "evd-run-r1",
  tenant: "acme",
  caseId: "c1",
  workdir: "/app",
  workspace: { kind: "repo", diff: "d", changedFiles: ["a"], headSha: "sha" },
  plan: { digest: "sha256:plan", graders: [{ id: "reward-file" }] },
  timeoutSec: 60,
  placementTarget: "rt-1",
  agentResultDigest: "sha256:the-half-that-was-judged",
} as unknown as VerifierJob;

const INVOCATION: VerifierInvocation = {
  planDigest: "sha256:plan",
  workspaceDigest: "sha256:workspace",
  scores: [{ graderId: "reward-file", metric: "tests_pass", value: 1, pass: true }],
};

const judgingBackend = {
  async dispatchVerifier(_job: VerifierJob, hooks: { authority: { reserve: (w: unknown) => Promise<unknown> } }) {
    await hooks.authority.reserve({ tenant: "acme", runId: "evd-run-r1", externalJobId: "everdict-verify-1" });
    return INVOCATION;
  },
  async capacity() {
    return { total: 4, used: 0 };
  },
};

// The store that cannot write. `owe` still lands, so the ledger names bytes that never appear — which is
// exactly the state the policy exists to have an opinion about.
const refusingVerdicts = {
  async put() {
    throw new Error("the verdict store refused the write");
  },
  async get() {
    return undefined;
  },
  async remove() {},
};

const access = (durability?: "required" | "best_effort") =>
  buildRuntimeAccess({
    runtimeRegistry: { get: async () => ({ id: "rt-1", kind: "local" }), list: async () => [] } as never,
    runtimeSecretsFor: async () => ({}),
    runtimeBuildBackend: () => judgingBackend as never,
    attempts: new InMemoryExecutionAttemptStore(),
    verdicts: refusingVerdicts,
    cleanup: new InMemoryIntermediateCleanupStore(),
    ...(durability ? { durability } : {}),
  } as never);

describe("[R70 COUNTEREXAMPLE] the deployment chooses its durability, and the composition carries it", () => {
  it("REFUSES a verdict whose bytes were not written, under required", async () => {
    const { dispatchVerifier } = access("required");
    await expect(
      dispatchVerifier(JOB),
      "a required deployment accepted a verdict whose bytes were refused",
    ).rejects.toThrow();
  });

  it("still returns the verdict under best_effort — the trade, made visibly", async () => {
    // Availability first, and it must keep working: this is what every deployment had before the policy
    // existed, and making the strict arm the default would start failing cases nobody asked to fail.
    const { dispatchVerifier } = access("best_effort");
    const invocation = await dispatchVerifier(JOB);
    expect(invocation.scores, "best_effort stopped producing a measurable verdict").toHaveLength(1);
  });

  it("defaults to best_effort when the deployment says nothing", async () => {
    const { dispatchVerifier } = access();
    const invocation = await dispatchVerifier(JOB);
    expect(invocation.scores).toHaveLength(1);
  });
});

describe("[R70 COUNTEREXAMPLE] the policy is read from configuration and validated against what is wired", () => {
  // `noDelete` is on, so the env is restored by ASSIGNMENT — and "" is the same as unset to the reader,
  // which is deliberate: an operator who blanks the variable has not chosen the strict arm.
  const before = process.env.EVERDICT_VERIFIER_DURABILITY ?? "";
  afterEach(() => {
    process.env.EVERDICT_VERIFIER_DURABILITY = before;
  });

  it("reads the two arms and defaults to best_effort", () => {
    process.env.EVERDICT_VERIFIER_DURABILITY = "";
    expect(verifierDurabilityFromEnv()).toBe("best_effort");
    process.env.EVERDICT_VERIFIER_DURABILITY = "required";
    expect(verifierDurabilityFromEnv()).toBe("required");
  });

  it("THROWS on a value it does not recognise, rather than falling back to the permissive arm", () => {
    // A misspelled `requird` silently meaning "best effort" is this whole law in miniature: the deployment
    // believes it chose the strict arm and the default answered for it.
    process.env.EVERDICT_VERIFIER_DURABILITY = "requird";
    expect(() => verifierDurabilityFromEnv(), "a typo was read as a deliberate best_effort").toThrow(/must be/);
  });

  it("REFUSES at boot when required is claimed without the stores it rests on", () => {
    expect(() =>
      assertVerifierDurabilitySatisfiable("required", { artifacts: false, cleanup: true, attempts: true }),
    ).toThrow(/artifact store/);
    expect(() =>
      assertVerifierDurabilitySatisfiable("required", { artifacts: true, cleanup: false, attempts: true }),
    ).toThrow(/cleanup ledger/);
    // …and best_effort is never refused: it is the arm that accepts the loss, so it has no preconditions.
    expect(() =>
      assertVerifierDurabilitySatisfiable("best_effort", { artifacts: false, cleanup: false, attempts: false }),
    ).not.toThrow();
  });
});
