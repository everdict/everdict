import { type Backend, buildRuntimeBackend, isReclaimable } from "@everdict/backends";
import { BadRequestError, type RuntimeSpec, UpstreamError } from "@everdict/contracts";
import type { RuntimeControlCommand, RuntimeControlResult } from "@everdict/contracts/wire";

export interface RuntimeControllerDeps {
  // Tenant SecretStore → backend secretEnv (resolves the cluster token/kubeconfig into an auth header; not put into the alloc env).
  secretsFor: (workspace: string) => Promise<Record<string, string>>;
  // Kinds buildRuntimeBackend can't build directly (e.g. topology) are injected by apps/api (falls back to buildRuntimeBackend).
  buildBackend?: (spec: RuntimeSpec, opts: { secretEnv?: Record<string, string> }) => Backend;
  timeoutMs?: number; // cap so a hung cluster call can't wedge the request (default 30s — reclaimIdle may stop several jobs)
}

// RuntimeSpec + a destructive command → build a live backend (same secrets/builder as inspect/probe) → run the
// control action. Unlike inspect (soft result), a non-controllable kind (local) or a build failure THROWS an
// AppError — this is a mutating admin action, so failures are real 4xx/5xx, not a degraded view. Actions are
// best-effort/idempotent on the backend; the caller re-inspects to see the effect.
export function makeRuntimeController(
  deps: RuntimeControllerDeps,
): (workspace: string, spec: RuntimeSpec, command: RuntimeControlCommand) => Promise<RuntimeControlResult> {
  const timeoutMs = deps.timeoutMs ?? 30_000;
  return async (workspace, spec, command) => {
    const secretEnv = await deps.secretsFor(workspace).catch(() => ({}) as Record<string, string>);
    const backend = (deps.buildBackend ?? buildRuntimeBackend)(spec, { secretEnv }); // a bad spec throws ConfigError → 4xx
    if (!isReclaimable(backend))
      throw new BadRequestError(
        "BAD_REQUEST",
        { kind: spec.kind },
        `The '${spec.kind}' runtime has no live cluster to control.`,
      );
    const act = async (): Promise<RuntimeControlResult> => {
      switch (command.action) {
        case "stopWorkload":
          await backend.stopWorkload(command.name);
          return { action: command.action, ok: true };
        case "reclaimIdle": {
          const r = await backend.reclaimIdle(command.olderThanSeconds);
          return { action: command.action, ok: true, stopped: r.stopped };
        }
        case "purgeTerminal": {
          const r = await backend.purgeTerminal();
          return { action: command.action, ok: true, purged: r.purged };
        }
        case "cordonNode":
          await backend.setNodeSchedulable(command.node, command.schedulable);
          return { action: command.action, ok: true };
      }
    };
    const timeout = new Promise<RuntimeControlResult>((_, reject) => {
      setTimeout(
        () =>
          reject(
            new UpstreamError(
              "UPSTREAM_ERROR",
              { action: command.action },
              `Control action timed out (${timeoutMs / 1000}s)`,
            ),
          ),
        timeoutMs,
      );
    });
    return Promise.race([act(), timeout]);
  };
}
