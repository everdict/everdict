import { type Backend, type ProbeResult, buildRuntimeBackend, isProbeable } from "@everdict/backends";
import type { RuntimeSpec } from "@everdict/core";

// Connection test result — checks only cluster reachability/auth, no job.
export interface RuntimeProbeResult {
  kind: string;
  reachable: boolean;
  detail: string;
  reason?: ProbeResult["reason"]; // structured failure class ("auth" | "unreachable" | "error"), undefined when reachable
}

export interface RuntimeProberDeps {
  // Tenant SecretStore → backend secretEnv (resolves the cluster token/kubeconfig into an auth header; not put into the alloc env).
  secretsFor: (workspace: string) => Promise<Record<string, string>>;
  // Kinds buildRuntimeBackend can't build directly, like topology, are injected by apps/api (falls back to buildRuntimeBackend).
  buildBackend?: (spec: RuntimeSpec, opts: { secretEnv?: Record<string, string> }) => Backend;
  timeoutMs?: number; // avoid hanging forever on an unreachable cluster (default 10s)
}

// RuntimeSpec → build a live backend (resolve cluster auth from the tenant's secrets) → probe() for reachability/auth.
// Uses the same builder/auth path as dispatch but runs no job → verifies "does it connect" exactly as at registration time.
export function makeRuntimeProber(
  deps: RuntimeProberDeps,
): (workspace: string, spec: RuntimeSpec) => Promise<RuntimeProbeResult> {
  const timeoutMs = deps.timeoutMs ?? 10_000;
  return async (workspace, spec) => {
    const secretEnv = await deps.secretsFor(workspace).catch(() => ({}) as Record<string, string>);
    const build = deps.buildBackend ?? buildRuntimeBackend;
    let backend: Backend;
    try {
      backend = build(spec, { secretEnv });
    } catch (e) {
      // A spec that can't even be built is a config error, not a reachability failure.
      return { kind: spec.kind, reachable: false, reason: "error", detail: e instanceof Error ? e.message : String(e) };
    }
    if (!isProbeable(backend))
      return {
        kind: spec.kind,
        reachable: false,
        detail: `The '${spec.kind}' runtime does not support connection testing.`,
      };
    // Cap so we don't wait out the TCP timeout (tens of seconds) of an unreachable cluster.
    const timeout = new Promise<ProbeResult>((resolve) => {
      setTimeout(
        () =>
          resolve({
            reachable: false,
            reason: "unreachable",
            detail: `Connection test timed out (${timeoutMs / 1000}s)`,
          }),
        timeoutMs,
      );
    });
    const r = await Promise.race([backend.probe(), timeout]);
    return { kind: spec.kind, reachable: r.reachable, detail: r.detail, ...(r.reason ? { reason: r.reason } : {}) };
  };
}
