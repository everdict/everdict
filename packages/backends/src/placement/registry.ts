import { NotFoundError } from "@everdict/contracts";
import type { Backend } from "../backend.js";

// name → Backend instance. 1 instance = 1 target (cluster/pool).
// Multiple Nomad/K8s/Windows targets are each registered as a separate instance.
export class BackendRegistry {
  private readonly map = new Map<string, Backend>();

  register(name: string, backend: Backend): this {
    this.map.set(name, backend);
    return this;
  }

  get(name: string): Backend {
    const backend = this.map.get(name);
    if (!backend) throw new NotFoundError("NOT_FOUND", { backend: name }, `backend '${name}' is not registered.`);
    return backend;
  }

  has(name: string): boolean {
    return this.map.has(name);
  }

  // The registered instance, or undefined — for a caller that wants to REUSE this deployment's target if it
  // exists and build one otherwise (the sandbox lane: a session and a case must never own the same cluster
  // twice). `get` is for callers where a missing target is the caller's error.
  tryGet(name: string): Backend | undefined {
    return this.map.get(name);
  }

  names(): string[] {
    return [...this.map.keys()];
  }

  // Drop a registered backend so the next dispatch rebuilds it (e.g. a tenant's secrets changed and the
  // instance has stale secretEnv baked in). In-flight dispatches keep their reference — this only unkeys it.
  unregister(name: string): boolean {
    return this.map.delete(name);
  }
}
