import { BadRequestError, type RuntimeSpec } from "@everdict/contracts";
import type { Backend } from "../backend.js";
import { K8sBackend, type K8sBackendOptions } from "../orchestrators/k8s.js";
import { LocalBackend } from "../orchestrators/local.js";
import { NomadBackend, type NomadBackendOptions } from "../orchestrators/nomad.js";

// --- Cluster-credential separation ---
// The cluster API token / kubeconfig authenticate the control plane TO the cluster API; they must never reach the
// alloc env (untrusted eval code). These helpers strip those keys from the tenant secret map before it becomes the
// job env, leaving only the agent's own model keys.

// A new map with one key removed from the secret map (unchanged if absent).
function withoutKey(
  env: Record<string, string> | undefined,
  key: string | undefined,
): Record<string, string> | undefined {
  if (!env || !key || !(key in env)) return env;
  const { [key]: _omitted, ...rest } = env;
  return rest;
}

// Remove several keys at once — for separating the cluster API token + kubeconfig from the alloc env together.
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
