import type { VerifierJob } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { verifierCaseJob } from "./verifier-placement.js";

// ── THE JUDGING HALF IS PLACED LIKE THE AGENT'S HALF (arch-review 57 P0-verifier) ────────────────────
//
// arch-review 56 gave the verifier its own container so the hidden tests and the reward namespace live
// somewhere the agent never was. What it did not give that container is a PLACEMENT: the K8s lane reads
//
//     const ns = this.opts.namespace ?? "default";
//     const secretEnv = this.opts.secretEnv ?? {};
//     const spec = { evalCase: { … }, tenant: job.tenant } as unknown as CaseJob;
//
// — the backend's defaults, not `resolve(job)`. So the two halves of one case can run in different worlds:
//
//     agent      tenant namespace · gVisor/Kata runtimeClass · tenant-scoped secrets
//     verifier   default namespace · default runtime · the backend's blanket secretEnv
//
// A verifier runs the task's own image and holds the credentials that decide the case. Placing it outside
// the tenant's trust zone is the isolation the zone exists to provide, missing on the half that produces the
// verdict — and it is UNTRUSTED code either way, since the image is the task's.
//
// The cast is how it got away with that. `as unknown as CaseJob` builds a job with no placement, no harness
// and no world, and a synthetic job with no placement is exactly a job `resolve` cannot resolve. That shape
// is why `scripts/check-constructed-casts.mjs` lists this file as OPEN debt: typing the job is the fix,
// because typing it forces the placement question to be answered.
//
// RED as of 927eddfc, observed:
//   Cannot find module './verifier-placement.js'
//
// This pins the JOB the verifier lane places. That the lane then calls `resolve` on it is the wiring, and
// `resolve`'s own behaviour (hardened isolation, zone namespace, tenant secrets) is already driven by the
// trust-zone tests beside it — the defect was never that `resolve` is wrong, it is that nobody asked it.

const verifierJob = (over: Partial<VerifierJob> = {}): VerifierJob =>
  ({
    runId: "r1",
    tenant: "acme",
    caseId: "c1",
    image: "registry.example/task:1",
    workdir: "/app",
    workspace: { kind: "repo", diff: "", changedFiles: [], headSha: "abc" },
    plan: { digest: "sha256:plan", graders: [{ id: "reward-file", config: {} }] },
    timeoutSec: 600,
    placementTarget: "rt-1",
    ...over,
  }) as VerifierJob;

describe("[R57 COUNTEREXAMPLE] a verifier is placed by the same rules as the agent it judges", () => {
  it("carries the TENANT, so the trust zone resolves to the same one the agent ran in", () => {
    const spec = verifierCaseJob(verifierJob());
    expect(spec.tenant, "the verifier would resolve under a different tenant than the agent").toBe("acme");
  });

  it("carries the PLACEMENT target — the lane a verifier resolves against is the agent's", () => {
    const spec = verifierCaseJob(verifierJob());
    expect(spec.evalCase.placement?.target).toBe("rt-1");
  });

  it("carries the task IMAGE, because the verifier's toolchain is the task's own", () => {
    const spec = verifierCaseJob(verifierJob());
    expect(spec.evalCase.image).toBe("registry.example/task:1");
  });

  it("carries the declared WORLD, so a case that asked for a box gets one to be judged in", () => {
    const declared = { cpu: 2000, memoryMb: 4096 };
    const spec = verifierCaseJob(verifierJob({ resources: declared }));
    expect(spec.evalCase.resources, "the verifier ran in a different box than the case declared").toEqual(declared);
  });

  it("carries the registry credentials the agent's image needed", () => {
    // A private task image the agent could pull and the verifier could not is a verdict that never happens.
    const auths = [{ host: "registry.example", username: "u", password: "p" }];
    const spec = verifierCaseJob(verifierJob({ registryAuths: auths }));
    expect(spec.registryAuths).toEqual(auths);
  });

  it("does NOT carry the agent's graders — the payload split is what Wave B closed", () => {
    // The whole point of the second container: the deciding graders travel in the VerifierJob, and the
    // synthetic CaseJob must not re-import the private material the agent's payload was stripped of.
    const spec = verifierCaseJob(verifierJob());
    expect(spec.evalCase.graders, "the verifier's synthetic job carried the deciding graders in plain sight").toEqual(
      [],
    );
  });

  it("names the case as a VERIFIER unit, so its work id cannot collide with the agent's", () => {
    const spec = verifierCaseJob(verifierJob());
    expect(spec.evalCase.id).not.toBe("c1");
    expect(spec.evalCase.id).toContain("c1");
  });
});
