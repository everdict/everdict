import type { RegistryAuth, VerifierInvocation, VerifierJob } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { buildRuntimeAccess } from "./runtime-access.js";

// ── THE MINT WAS RIGHT AND THE BACKEND NEVER SAW IT (arch-review 65 P1-high) ─────────────────────────
//
// arch-review 64 taught this lane to mint ONE pull grant over every image the verifier's pod pulls — its task
// image and the runtime's runner/init image, which can live in different repositories of one managed registry.
// The mint landed. The dispatch did not:
//
//     const dispatched: VerifierJob = { ...job, registryAuths: [...podAuths, ...] };
//     invocation = await verifierOperation(deps, job, …);   // ← `job`, not `dispatched`
//
// So a private runner image beside a public task image still put the verifier pod in ImagePullBackOff, with
// the CASE wearing a failure that belongs to our wiring. The K8s lane builds its pull Secret from
// `job.registryAuths`, so the consumer is direct and the value simply never arrived.
//
// The local was computed and never read, which review missed and the compiler was not asked: `noUnusedLocals`
// was off. Turning it on is what found this line — and three more dead helpers, two dead private methods and a
// dead store read, all of the same shape.
//
// THIS FILE ASSERTS ON WHAT THE BACKEND RECEIVED, deliberately. A test of the mint — "did we compute a
// grant?" — was available the whole time and would have stayed green through every version of this defect. The
// only question that distinguishes them is what the consumer got.
//
// Seen RED with `job` restored in place of `dispatched`, observed:
//   undefined is not iterable (cannot read property Symbol(Symbol.iterator))
//   expected [ { host: 'ghcr.io', … } ] to deep equally contain { host: 'private.registry', … }
//
// The first message is `toContainEqual` meeting an ABSENT `registryAuths`, which is the defect stated as
// bluntly as a matcher can state it: the lane handed the backend a job with no credentials at all.

const JOB: VerifierJob = {
  runId: "evd-run-r1",
  tenant: "acme",
  caseId: "c1",
  // A PUBLIC task image, so the job carries no credential of its own — which is exactly the combination that
  // hid this: with a private task image the job's own auths reach the lane and the runner's absence is subtler.
  image: "docker.io/library/alpine:3",
  workdir: "/app",
  workspace: { kind: "repo", diff: "", changedFiles: [], base: "b", headSha: "h" },
  plan: { digest: "sha256:plan", graders: [] },
  timeoutSec: 60,
  // The lane this verifier is placed on — the same runtime whose runner image needs the grant.
  placementTarget: "rt-1",
} as unknown as VerifierJob;

const RUNNER_GRANT: RegistryAuth = { host: "private.registry", username: "everdict", password: "runner-token" };

// A runtime whose RUNNER image is private — the image every managed pod pulls and the one nothing had minted
// a grant for.
const RUNTIME_SPEC = { id: "rt-1", version: "1", kind: "k8s", image: "private.registry/platform/job-runner:2" };

const accessWith = (seen: VerifierJob[], registryAuthsFor?: unknown) =>
  buildRuntimeAccess({
    runtimeRegistry: { get: async () => RUNTIME_SPEC, list: async () => [] } as never,
    runtimeSecretsFor: async () => ({}),
    runtimeBuildBackend: () =>
      ({
        id: "rt-1",
        capacity: async () => ({ total: 20, used: 0 }),
        dispatch: async () => {
          throw new Error("not under test");
        },
        // THE SPY. What the lane actually handed the backend is the only thing that answers this question.
        dispatchVerifier: async (job: VerifierJob): Promise<VerifierInvocation> => {
          seen.push(job);
          return { planDigest: "sha256:plan", workspaceDigest: "w", scores: [] } as unknown as VerifierInvocation;
        },
      }) as never,
    ...(registryAuthsFor !== undefined ? { registryAuthsFor: registryAuthsFor as never } : {}),
  });

describe("[R65 COUNTEREXAMPLE] the verifier's backend receives the credentials minted for its pod", () => {
  it("hands the lane the ENRICHED job, not the one it was asked about", async () => {
    const seen: VerifierJob[] = [];
    await accessWith(seen, async () => [RUNNER_GRANT]).dispatchVerifier(JOB);

    expect(seen, "the verifier was never dispatched, so this file measured nothing").toHaveLength(1);
    expect(
      seen[0]?.registryAuths,
      "the verifier's pod got no credential for the runner image it must pull",
    ).toContainEqual(RUNNER_GRANT);
  });

  it("keeps the job's OWN credentials beside the minted one", async () => {
    // The control in one direction: enriching must not replace what the case already carried. A private task
    // image on another host still needs its own grant.
    const own: RegistryAuth = { host: "ghcr.io", username: "everdict", password: "task-token" };
    const seen: VerifierJob[] = [];
    await accessWith(seen, async () => [RUNNER_GRANT]).dispatchVerifier({
      ...JOB,
      registryAuths: [own],
    } as VerifierJob);

    expect(seen[0]?.registryAuths).toContainEqual(own);
    expect(seen[0]?.registryAuths).toContainEqual(RUNNER_GRANT);
  });

  it("dispatches unchanged when there is nothing to mint", async () => {
    // The control in the other direction. A deployment with no credential resolver, or a runtime whose runner
    // image needs none, must dispatch the job as it stands rather than an empty-auth copy of it.
    const seen: VerifierJob[] = [];
    await accessWith(seen).dispatchVerifier(JOB);
    expect(seen[0]?.registryAuths).toBeUndefined();
  });
});
