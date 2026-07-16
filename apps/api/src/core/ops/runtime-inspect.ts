import { type Backend, buildRuntimeBackend, isInspectable } from "@everdict/backends";
import type { RuntimeSpec } from "@everdict/contracts";
import type { InspectRuntimeResult } from "@everdict/contracts/wire";

export interface RuntimeInspectorDeps {
  // Tenant SecretStore → backend secretEnv (resolves the cluster token/kubeconfig into an auth header; not put into the alloc env).
  secretsFor: (workspace: string) => Promise<Record<string, string>>;
  // Kinds buildRuntimeBackend can't build directly (e.g. topology) are injected by apps/api (falls back to buildRuntimeBackend).
  buildBackend?: (spec: RuntimeSpec, opts: { secretEnv?: Record<string, string> }) => Backend;
  timeoutMs?: number; // avoid hanging forever on a slow/unreachable cluster (default 15s — inspect makes a few cheap reads)
}

// RuntimeSpec → build a live backend (resolve cluster auth from the tenant's secrets) → inspect() for a read-only
// cluster view. Uses the same builder/auth path as dispatch/probe but runs no job. A non-inspectable kind (local) or
// a build failure returns a not-reachable result rather than throwing — the caller renders it the same as a degraded cluster.
export function makeRuntimeInspector(
  deps: RuntimeInspectorDeps,
): (workspace: string, spec: RuntimeSpec) => Promise<InspectRuntimeResult> {
  const timeoutMs = deps.timeoutMs ?? 15_000;
  return async (workspace, spec) => {
    const secretEnv = await deps.secretsFor(workspace).catch(() => ({}) as Record<string, string>);
    const build = deps.buildBackend ?? buildRuntimeBackend;
    let backend: Backend;
    try {
      backend = build(spec, { secretEnv });
    } catch (e) {
      // A spec that can't even be built is a config error, not a reachability failure.
      return {
        kind: spec.kind,
        reachable: false,
        reason: "error",
        detail: e instanceof Error ? e.message : String(e),
        warnings: [],
      };
    }
    if (!isInspectable(backend))
      return {
        kind: spec.kind,
        reachable: false,
        detail: `The '${spec.kind}' runtime has no live cluster to inspect.`,
        warnings: [],
      };
    // Cap so a slow cluster doesn't wedge the request. inspect() is itself best-effort, but the outer race guards a hang.
    const timeout = new Promise<InspectRuntimeResult>((resolve) => {
      setTimeout(
        () =>
          resolve({
            kind: spec.kind,
            reachable: false,
            reason: "unreachable",
            detail: `Inspection timed out (${timeoutMs / 1000}s)`,
            warnings: [],
          }),
        timeoutMs,
      );
    });
    return Promise.race([backend.inspect(), timeout]);
  };
}
