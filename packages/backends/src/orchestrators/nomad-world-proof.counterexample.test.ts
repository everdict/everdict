import type { CaseJob } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { type NomadBackendOptions, buildNomadJob } from "./nomad.js";

// ── A PROOF IS BORN FROM THE SAME BUILDER AS THE EFFECT (arch-review 59 P0-world) ────────────────────
//
// The Nomad task builder read CPU and memory from the case and GPU from the HARNESS spec only:
//
//     const gpuCount = harnessSpec.resources?.gpu ?? opts.gpu;
//
// `job.evalCase.resources?.gpu` was simply absent. And the payload beside it stamped
// `withWorldProof(job, "nomad", job.evalCase.resources)` — the WHOLE declaration — as the world this
// placement had enforced.
//
// So a case asking for one GPU got a task with no device request and an in-container proof saying `gpu: 1`
// was applied. That is worse than the refusal it replaced. A refusal is visible; a false attestation makes
// `worldProofCovers` ACCEPT, the driver runs, and the score is reported as if the declared world had been
// provided. The one mechanism built to catch an unenforced world was told the world was fine, by us.
//
// The repair is not "add the missing `??` term" — that fixes this axis and leaves the shape that produced
// it. One function answers what this lane will natively apply, and the manifest and the proof are two
// renderings of that single answer. An axis it cannot render is absent from BOTH, and silence is what
// `worldProofCovers` reads as "not enforced" — the fail-closed direction.
//
// Seen RED before the shared builder existed, observed:
//   the lane attested a GPU it never requested: expected undefined to be 1

const NOMAD: NomadBackendOptions = { addr: "http://nomad.test:4646", image: "runner:1", cpuMhzPerCore: 2400 };

const job = (over: Record<string, unknown> = {}): CaseJob =>
  ({
    tenant: "acme",
    runId: "evd-run-r1",
    harness: { id: "h", version: "1" },
    evalCase: { id: "c1", task: "t", env: { kind: "prompt" }, graders: [], timeoutSec: 60, ...over },
  }) as unknown as CaseJob;

const taskOf = (spec: ReturnType<typeof buildNomadJob>) => {
  const task = spec.Job.TaskGroups[0]?.Tasks[0];
  if (!task) throw new Error("no task in the job spec");
  return task;
};

// What the agent's container is told about the world it was given.
const proofOf = (spec: ReturnType<typeof buildNomadJob>) => {
  const payload = taskOf(spec).Env?.EVERDICT_CASE_JOB;
  if (payload === undefined) throw new Error("no case payload on the task");
  return (JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as CaseJob).worldProof;
};

describe("[R59 COUNTEREXAMPLE] the Nomad lane attests only the world it actually requested", () => {
  it("requests the GPU the CASE declared", () => {
    const spec = buildNomadJob(job({ resources: { gpu: 1 } }), NOMAD);
    const devices = taskOf(spec).Resources.Devices as Array<{ Name: string; Count: number }> | undefined;
    expect(devices, "the lane attested a GPU it never requested").toBeDefined();
    expect(devices?.[0]).toMatchObject({ Name: "nvidia/gpu", Count: 1 });
  });

  it("attests exactly what it requested, never the raw declaration", () => {
    const proof = proofOf(buildNomadJob(job({ resources: { gpu: 1, cpu: 2000, memoryMb: 4096 } }), NOMAD));
    expect(proof?.resources, "the proof is a copy of the request rather than of the effect").toEqual({
      gpu: 1,
      cpu: 2000,
      memoryMb: 4096,
    });
  });

  it("does NOT attest an axis it could not render", () => {
    // The failure mode this whole file is about, inverted. If a lane cannot apply an axis it must not claim
    // it — `worldProofCovers` reads silence as "not enforced", which refuses in the container instead of
    // running in a world nobody provided.
    const spec = buildNomadJob(job({ resources: { cpu: 2000 } }), NOMAD);
    expect(proofOf(spec)?.resources?.gpu).toBeUndefined();
    expect(taskOf(spec).Resources.Devices).toBeUndefined();
  });

  it("still lets the HARNESS declare a GPU when the case does not", () => {
    // Precedence, not replacement: the case is the more specific statement, the harness spec is the default.
    const viaHarness = {
      ...job(),
      harnessSpec: { kind: "command", command: "run", resources: { gpu: 2 } },
    } as unknown as CaseJob;
    const devices = taskOf(buildNomadJob(viaHarness, NOMAD)).Resources.Devices as Array<{ Count: number }> | undefined;
    expect(devices?.[0]?.Count).toBe(2);
  });

  it("lets the CASE win over the harness — the more specific statement about this unit of work", () => {
    const both = {
      ...job({ resources: { gpu: 1 } }),
      harnessSpec: { kind: "command", command: "run", resources: { gpu: 4 } },
    } as unknown as CaseJob;
    const devices = taskOf(buildNomadJob(both, NOMAD)).Resources.Devices as Array<{ Count: number }> | undefined;
    expect(devices?.[0]?.Count).toBe(1);
  });
});
