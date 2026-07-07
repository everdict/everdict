import { runAgentJob } from "@everdict/agent";
import type { AgentJob, CaseResult } from "@everdict/core";
import type { Backend, BackendCapacity, ProbeResult } from "./backend.js";

// For dev / single host — runs the job in the same process (no isolation).
// claude uses this machine's subscription login.
export class LocalBackend implements Backend {
  readonly id = "local";
  // maxConcurrent may also be a function — lets it read slots that the autoscaler changes dynamically.
  constructor(private readonly maxConcurrent: number | (() => number) = 4) {}

  async capacity(): Promise<BackendCapacity> {
    // in-process execution — slots come from config, usage is gated by the scheduler's in-flight.
    const total = typeof this.maxConcurrent === "function" ? this.maxConcurrent() : this.maxConcurrent;
    return { total, used: 0 };
  }

  dispatch(job: AgentJob): Promise<CaseResult> {
    return runAgentJob(job);
  }

  // in-process — no cluster, so always reachable (the control-plane host itself).
  async probe(): Promise<ProbeResult> {
    return { reachable: true, detail: "in-process (control-plane host)" };
  }
}
