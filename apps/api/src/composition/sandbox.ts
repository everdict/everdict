import type {
  CapabilityStore,
  PlatformEventEmitter,
  RunStore,
  SandboxSessionServiceDeps,
  TrajectoryStore,
} from "@everdict/application-control";
import { SandboxSessionService } from "@everdict/application-control";
import { canConsumeCapability } from "@everdict/domain";
import { DockerDriver } from "@everdict/drivers";

// Sandbox session runs (execution-model P6) are OPT-IN infrastructure, exactly like file execution: the
// service exists only where the control plane can reach a container runtime (EVERDICT_SANDBOX_DRIVER=docker,
// which needs the docker socket mounted into the api container). Everywhere else the routes and the tools
// are simply absent. Caps default CLOSED-ish (2 per tenant / 8 total) — a session is a scarcer resource than
// an eval case because nothing ends it but the clock.
export function buildSandboxSessions(opts: {
  store: RunStore;
  trajectories?: TrajectoryStore;
  events?: PlatformEventEmitter;
  capabilities?: CapabilityStore;
  // The durable reaper (T-b) — main wires it to the Temporal driver when EVERDICT_TEMPORAL_ADDRESS is set;
  // absent = the in-process sweep is the only expiry (a process death can leak until a reaper exists).
  reaper?: SandboxSessionServiceDeps["reaper"];
}): SandboxSessionService | undefined {
  const driver = process.env.EVERDICT_SANDBOX_DRIVER;
  if (driver === undefined || driver === "") return undefined;
  if (driver !== "docker") {
    console.warn(`▶ sandbox sessions: ignoring EVERDICT_SANDBOX_DRIVER='${driver}' (only 'docker' is supported)`);
    return undefined;
  }
  console.log("▶ sandbox sessions: docker (POST /sandboxes + create_sandbox)");
  const capabilities = opts.capabilities;
  return new SandboxSessionService({
    store: opts.store,
    driver: new DockerDriver(),
    ...(opts.trajectories ? { trajectories: opts.trajectories } : {}),
    ...(opts.events ? { events: opts.events } : {}),
    ...(opts.reaper ? { reaper: opts.reaper } : {}),
    ...(capabilities
      ? {
          // environment ref → the concrete image, through the same consume gate as adoption (a cross-tenant
          // private capability resolves to undefined → 404 upstream, no existence leak).
          resolveEnvironmentImage: async (
            tenant: string,
            subject: string,
            ref: { source?: string; id: string; version?: string },
          ) => {
            const rec = await capabilities.get(ref.source ?? tenant, ref.id, ref.version).catch(() => undefined);
            if (!rec || rec.spec.type !== "environment" || !canConsumeCapability(rec, { tenant, subject }))
              return undefined;
            return { image: rec.spec.image, version: rec.version };
          },
        }
      : {}),
    maxPerTenant: intEnv("EVERDICT_SANDBOX_MAX_PER_TENANT") ?? 2,
    maxTotal: intEnv("EVERDICT_SANDBOX_MAX_TOTAL") ?? 8,
    ...(intEnv("EVERDICT_SANDBOX_TTL_SEC") !== undefined ? { defaultTtlSec: intEnv("EVERDICT_SANDBOX_TTL_SEC") } : {}),
  });
}

function intEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
