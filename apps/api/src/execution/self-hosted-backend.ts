import {
  type Backend,
  type BackendCapacity,
  type DispatchOptions,
  type ProbeResult,
  type Probeable,
  dispatchAborted,
} from "@everdict/backends";
import type { AgentJob, CaseResult } from "@everdict/core";
import type { RunnerHub, SelfHostedKey } from "../runners/runner-hub.js";

// Personally-owned self-hosted runner backend — pull, not push. dispatch(job) parks the job in the RunnerHub and
// returns a promise. When the runner client (everdict runner) leases it via MCP, runs it on its own machine, and reports
// the result back, that promise resolves. The backend instance is registered per runner (= key) by RuntimeDispatcher.
// Design: docs/architecture/self-hosted-runner.md.
export class SelfHostedBackend implements Backend, Probeable {
  constructor(
    private readonly key: SelfHostedKey,
    private readonly hub: RunnerHub,
    // Per-runner concurrent-park ceiling — for scheduler gating (parking uses no real resources, so keep it generous; the real serialization is done by lease availability).
    private readonly maxConcurrent = 8,
  ) {}
  async capacity(): Promise<BackendCapacity> {
    // used is 0 since the scheduler tracks it via its own in-flight (here the park queue absorbs the real waiting).
    return { total: this.maxConcurrent, used: 0 };
  }
  async dispatch(job: AgentJob, opts?: DispatchOptions): Promise<CaseResult> {
    if (opts?.signal?.aborted) throw dispatchAborted(job); // best-effort: refuse a pre-cancelled park
    const { result, ranBy } = await this.hub.enqueue(this.key, job);
    // Provenance is stamped by the control plane (not runner self-reported) — record in the result that this ran on an unmanaged personal host (D2).
    // runner = the runner that actually completed it (ranBy). For a pool (self:ws) job key.runnerId is "*" (the pool), so use ranBy to record the real runner.
    return { ...result, provenance: { ranOn: "self-hosted", runner: ranBy, by: this.key.owner } };
  }
  // There's no way (as of Slice 3) to assert "is a runner attached" without a job — in the pull model, connection state only shows through lease polling.
  // Report only the number of waiting jobs (they drain quickly if a runner is attached). Precise presence/heartbeat is Slice 6.
  async probe(): Promise<ProbeResult> {
    const pending = this.hub.pending(this.key);
    return { reachable: true, detail: `self-hosted runner (pull); pending jobs: ${pending}` };
  }
}
