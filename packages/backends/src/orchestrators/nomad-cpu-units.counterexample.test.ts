import type { CaseJob } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { type NomadBackendOptions, buildNomadJob } from "./nomad.js";

// ── TWO UNITS MAY NOT SHARE A FIELD (arch-review 58 P1) ──────────────────────────────────────────────
//
// `ResourceRequest.cpu` is MILLICORES — the schema says so, in one sentence, because the whole point of that
// leaf module is that there is ONE spelling of "how big a box". Nomad's `Resources.CPU` is MEGAHERTZ. The
// task builder wrote
//
//     CPU: job.evalCase.resources?.cpu ?? harnessSpec.resources?.cpu ?? opts.cpuMhz ?? 1000
//
// which puts a millicore value and an MHz value in the same `??` chain, as alternatives for one field. A case
// declaring `cpu: 2000` — two vCPUs — asked the cluster for 2000 MHz, which on a 3 GHz node is about
// two-thirds of ONE core: a third of the box it declared.
//
// Under-provisioning would merely be a bug. What makes it a protocol defect is what the lane says afterwards:
// `withWorldProof(job, "nomad", job.evalCase.resources)` stamps the DECLARED millicores as the world this
// placement enforced, the in-container driver checks the proof against the same declaration, they match, and
// the case runs in a third of its box with a receipt saying otherwise. arch-review 57 built that proof so a
// declared world could not be silently unenforced; a unit error walks straight through it, because both sides
// are reading the same number.
//
// So the conversion is explicit and the assumption it needs is NAMED. Millicores → MHz requires the cluster's
// per-core clock, which the control plane cannot know: an operator states it (`cpuMhzPerCore`), or this lane
// cannot honour a cpu declaration and REFUSES rather than placing a box it will then attest to. That is the
// same rule the network axis already follows here — an axis we do not enforce is one we do not claim.
//
// Seen RED before the conversion existed, observed:
//   a two-vCPU case was placed as 2000 MHz: expected 2000 to be 6000

const job = (over: Record<string, unknown> = {}): CaseJob =>
  ({
    tenant: "acme",
    runId: "evd-run-r1",
    harness: { id: "h", version: "1" },
    evalCase: {
      id: "c1",
      task: "t",
      env: { kind: "prompt" },
      graders: [],
      resources: { cpu: 2000, memoryMb: 4096 },
    },
    ...over,
  }) as unknown as CaseJob;

// The lane's non-negotiable options, so each case below states only the thing it is about.
const lane = (over: Partial<NomadBackendOptions> = {}): NomadBackendOptions => ({
  addr: "http://nomad.test:4646",
  image: "runner:1",
  ...over,
});

const taskOf = (spec: ReturnType<typeof buildNomadJob>) => {
  const task = spec.Job.TaskGroups[0]?.Tasks[0];
  if (!task) throw new Error("no task in the job spec");
  return task.Resources;
};

describe("[R58 COUNTEREXAMPLE] a millicore declaration is not placed as megahertz", () => {
  it("converts the declared millicores using the operator's stated per-core clock", () => {
    const task = taskOf(buildNomadJob(job(), lane({ cpuMhzPerCore: 3000 })));
    // 2000 millicores = 2 vCPU; on a 3 GHz core that is 6000 MHz.
    expect(task.CPU, "a two-vCPU case was placed as 2000 MHz").toBe(6000);
    // MiB is MiB on both sides — it was never the broken axis, and a fix that moved it would be a new bug.
    expect(task.MemoryMB).toBe(4096);
  });

  it("REFUSES a cpu declaration when the cluster's clock was never stated", () => {
    // The honest failure. Placing the number anyway is what produced a receipt for a world nobody provided,
    // and this refusal names the setting that fixes it.
    expect(() => buildNomadJob(job(), lane())).toThrow(/cpuMhzPerCore/);
  });

  it("still places a case that declares NO cpu, using the lane's own MHz default", () => {
    // `cpuMhz` is a lane default expressed in the cluster's own unit. It was only ever wrong as an
    // ALTERNATIVE to a millicore declaration; on its own it is exactly right, and an undeclared case makes
    // no claim for a proof to contradict.
    const bare = job({ evalCase: { id: "c1", task: "t", env: { kind: "prompt" }, graders: [] } });
    const task = taskOf(buildNomadJob(bare, lane({ cpuMhz: 2500 })));
    expect(task.CPU).toBe(2500);
  });

  it("refuses on the HARNESS's declaration too — the unit does not depend on who declared it", () => {
    const viaHarness = job({
      evalCase: { id: "c1", task: "t", env: { kind: "prompt" }, graders: [] },
      harnessSpec: { kind: "command", command: "run", resources: { cpu: 1000 } },
    });
    expect(() => buildNomadJob(viaHarness, lane())).toThrow(/cpuMhzPerCore/);
    expect(taskOf(buildNomadJob(viaHarness, lane({ cpuMhzPerCore: 2400 }))).CPU).toBe(2400);
  });
});
