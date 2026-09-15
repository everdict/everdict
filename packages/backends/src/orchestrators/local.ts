import { BadRequestError, type CaseJob, type CaseResult } from "@everdict/contracts";
import type { TrustZonePolicy } from "@everdict/domain";
import { runCaseJob } from "@everdict/job-runner";
import {
  type Backend,
  type BackendCapacity,
  type DispatchOptions,
  type ProbeResult,
  type Probeable,
  dispatchAborted,
} from "../backend.js";

// For dev / single host — runs the job in the same process (no isolation).
// claude uses this machine's subscription login.
//
// ⚠️ UNDER TRUST ZONES IT REFUSES AN UNTRUSTED TENANT. An operator who configures per-tenant zones has said an
// untrusted tenant runs only on a hardened runtime (`assertHardenedIsolation`), and a job here runs inside the
// control-plane process, which isolates nothing. A tenant-registered `kind: "local"` runtime used to skip the zones
// entirely — registering a runtime is viewer+ — so any tenant could run a command harness on the control-plane host.
export class LocalBackend implements Backend, Probeable {
  // maxConcurrent may also be a function — lets it read slots that the autoscaler changes dynamically.
  constructor(
    private readonly maxConcurrent: number | (() => number) = 4,
    private readonly opts: { trustZones?: TrustZonePolicy } = {},
  ) {}

  async capacity(): Promise<BackendCapacity> {
    // in-process execution — slots come from config, usage is gated by the scheduler's in-flight.
    const total = typeof this.maxConcurrent === "function" ? this.maxConcurrent() : this.maxConcurrent;
    return { total, used: 0 };
  }

  dispatch(job: CaseJob, opts?: DispatchOptions): Promise<CaseResult> {
    const zone = this.opts.trustZones?.resolve(job.tenant ?? "default");
    if (zone !== undefined && !zone.trusted)
      return Promise.reject(
        new BadRequestError(
          "BAD_REQUEST",
          { zone: zone.id, runtime: "local" },
          `Untrusted tenant zone '${zone.id}' cannot run on a local runtime: it executes inside the control-plane process and isolates nothing. Use a nomad or k8s runtime.`,
        ),
      );
    // In-process — can't interrupt a started run, so honor the signal best-effort by refusing a not-yet-started one.
    if (opts?.signal?.aborted) return Promise.reject(dispatchAborted(job));
    opts?.onStarted?.(); // dispatch = the case begins now (this backend has no queue) → flip the run record to running
    return runCaseJob(job);
  }

  // in-process — no cluster, so always reachable (the control-plane host itself).
  async probe(): Promise<ProbeResult> {
    return { reachable: true, detail: "in-process (control-plane host)" };
  }
}
