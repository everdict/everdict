import { type AgentJob, BadRequestError, type CaseResult } from "@everdict/core";
import type { DispatchOptions } from "./backend.js";
import type { BackendRegistry } from "./registry.js";

// Control plane: pick a backend by the job's placement.target (or default) and dispatch.
export class Router {
  constructor(
    private readonly registry: BackendRegistry,
    private readonly defaultTarget?: string,
  ) {}

  // async: makes a synchronous throw consistently a rejection (the caller handles it with await/.catch).
  async dispatch(job: AgentJob, opts?: DispatchOptions): Promise<CaseResult> {
    const target = job.evalCase.placement?.target ?? this.defaultTarget;
    if (!target) {
      throw new BadRequestError("BAD_REQUEST", undefined, "placement.target or a default backend is required.");
    }
    return this.registry.get(target).dispatch(job, opts);
  }
}
