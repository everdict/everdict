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

  names(): string[] {
    return [...this.map.keys()];
  }
}
