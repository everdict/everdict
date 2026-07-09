import { type AgentJob, BadRequestError, type CaseResult, NotFoundError, type RuntimeSpec } from "@everdict/core";
import { z } from "zod";
import type { Backend, DispatchOptions } from "./backend.js";
import { K8sBackend, type K8sBackendOptions } from "./k8s.js";
import { LocalBackend } from "./local.js";
import { NomadBackend, type NomadBackendOptions } from "./nomad.js";

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

// --- Build the registry from config (declares multiple clusters/pools; Zod-validated as external input) ---
export const BackendConfigSchema = z.discriminatedUnion("kind", [
  z.object({ name: z.string(), kind: z.literal("local") }),
  z.object({
    name: z.string(),
    kind: z.literal("nomad"),
    addr: z.string(),
    image: z.string(),
    runtime: z.string().optional(),
    datacenters: z.array(z.string()).optional(),
  }),
  z.object({
    name: z.string(),
    kind: z.literal("k8s"),
    image: z.string(),
    context: z.string().optional(), // kubeconfig context (e.g. kind-everdict)
    namespace: z.string().optional(),
    runtimeClass: z.string().optional(), // gVisor=gvisor etc.
  }),
]);
export type BackendConfig = z.infer<typeof BackendConfigSchema>;

export const BackendsConfigSchema = z.object({
  default: z.string().optional(),
  backends: z.array(BackendConfigSchema),
});
export type BackendsConfig = z.infer<typeof BackendsConfigSchema>;

// A new map with one key removed from the secret map (unchanged if absent). Used to separate the cluster API token from the alloc env.
function withoutKey(
  env: Record<string, string> | undefined,
  key: string | undefined,
): Record<string, string> | undefined {
  if (!env || !key || !(key in env)) return env;
  const { [key]: _omitted, ...rest } = env;
  return rest;
}

// Remove several keys at once. For separating the cluster API token + kubeconfig from the alloc env together.
function withoutKeys(
  env: Record<string, string> | undefined,
  ...keys: (string | undefined)[]
): Record<string, string> | undefined {
  let out = env;
  for (const key of keys) out = withoutKey(out, key);
  return out;
}

// RuntimeSpec(nomad) + tenant secret map → NomadBackendOptions.
// authSecret (a name) resolves to a Nomad API (ACL) token used as X-Nomad-Token, and is excluded from the alloc env (never exposed to the agent).
export function nomadRuntimeOptions(
  spec: Extract<RuntimeSpec, { kind: "nomad" }>,
  secretEnv?: Record<string, string>,
): NomadBackendOptions {
  const apiToken = spec.authSecret ? secretEnv?.[spec.authSecret] : undefined;
  const allocEnv = withoutKey(secretEnv, spec.authSecret);
  return {
    addr: spec.addr,
    image: spec.image,
    ...(spec.runtime ? { runtime: spec.runtime } : {}),
    ...(spec.datacenters ? { datacenters: spec.datacenters } : {}),
    ...(spec.namespace ? { namespace: spec.namespace } : {}),
    ...(spec.maxConcurrent !== undefined ? { maxConcurrent: spec.maxConcurrent } : {}),
    ...(spec.memoryBudgetMb !== undefined ? { memoryBudgetMb: spec.memoryBudgetMb } : {}),
    ...(spec.cpuBudget !== undefined ? { cpuBudget: spec.cpuBudget } : {}),
    ...(apiToken ? { apiToken } : {}),
    ...(allocEnv && Object.keys(allocEnv).length > 0 ? { secretEnv: allocEnv } : {}),
  };
}

// RuntimeSpec(k8s) + tenant secret map → K8sBackendOptions. authSecret (bearer token) / kubeconfigSecret (full kubeconfig)
// resolve to cluster-API auth, and both are excluded from the alloc env (never expose cluster credentials to untrusted eval code).
export function k8sRuntimeOptions(
  spec: Extract<RuntimeSpec, { kind: "k8s" }>,
  secretEnv?: Record<string, string>,
): K8sBackendOptions {
  const apiToken = spec.authSecret ? secretEnv?.[spec.authSecret] : undefined;
  const kubeconfig = spec.kubeconfigSecret ? secretEnv?.[spec.kubeconfigSecret] : undefined;
  const allocEnv = withoutKeys(secretEnv, spec.authSecret, spec.kubeconfigSecret);
  return {
    image: spec.image,
    ...(spec.context ? { context: spec.context } : {}),
    ...(spec.namespace ? { namespace: spec.namespace } : {}),
    ...(spec.runtimeClass ? { runtimeClass: spec.runtimeClass } : {}),
    ...(spec.server ? { server: spec.server } : {}),
    ...(spec.maxConcurrent !== undefined ? { maxConcurrent: spec.maxConcurrent } : {}),
    ...(spec.memoryBudgetMb !== undefined ? { memoryBudgetMb: spec.memoryBudgetMb } : {}),
    ...(spec.cpuBudget !== undefined ? { cpuBudget: spec.cpuBudget } : {}),
    ...(apiToken ? { apiToken } : {}),
    ...(kubeconfig ? { kubeconfig } : {}),
    ...(allocEnv && Object.keys(allocEnv).length > 0 ? { secretEnv: allocEnv } : {}),
  };
}

// A tenant-registered RuntimeSpec (@everdict/core) → a live Backend. Model/cluster credentials are injected via secretEnv (the spec holds no secrets).
// The cluster API token (authSecret) is used as an auth header and separated from the alloc env (the option builders above).
// The control plane uses this at dispatch time to build a tenant runtime and register it in the Scheduler registry.
export function buildRuntimeBackend(spec: RuntimeSpec, opts: { secretEnv?: Record<string, string> } = {}): Backend {
  if (spec.kind === "local") return new LocalBackend();
  if (spec.kind === "k8s") return new K8sBackend(k8sRuntimeOptions(spec, opts.secretEnv));
  if (spec.kind === "nomad") return new NomadBackend(nomadRuntimeOptions(spec, opts.secretEnv));
  // The union (local|nomad|k8s) is exhausted — unreachable at compile time. topology-capable (nomad/k8s + traceSource)
  // needs @everdict/topology ServiceTopologyBackend (no circular dep allowed) → handled by apps/api's buildBackend.
  // Runtime defense: explicitly reject an unvalidated kind arriving at the boundary (get the kind string only via a never cast).
  return assertNeverRuntimeKind(spec);
}

function assertNeverRuntimeKind(spec: never): never {
  const kind = (spec as { kind?: string }).kind;
  throw new BadRequestError(
    "BAD_REQUEST",
    { kind },
    `buildRuntimeBackend does not build '${kind}' directly (topology-capable runtimes go through apps/api buildBackend).`,
  );
}

export function buildRegistry(
  cfg: BackendsConfig,
  opts: { secretEnv?: Record<string, string> } = {},
): { registry: BackendRegistry; defaultTarget: string | undefined } {
  const registry = new BackendRegistry();
  for (const b of cfg.backends) {
    if (b.kind === "local") {
      registry.register(b.name, new LocalBackend());
    } else if (b.kind === "k8s") {
      registry.register(
        b.name,
        new K8sBackend({
          image: b.image,
          context: b.context,
          namespace: b.namespace,
          runtimeClass: b.runtimeClass,
          secretEnv: opts.secretEnv,
        }),
      );
    } else {
      registry.register(
        b.name,
        new NomadBackend({
          addr: b.addr,
          image: b.image,
          runtime: b.runtime,
          datacenters: b.datacenters,
          secretEnv: opts.secretEnv,
        }),
      );
    }
  }
  return { registry, defaultTarget: cfg.default };
}
