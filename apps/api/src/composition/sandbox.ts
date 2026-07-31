import type {
  CapabilityStore,
  PlatformEventEmitter,
  ResolvedSessionHarness,
  RunStore,
  SandboxSessionServiceDeps,
  TrajectoryStore,
} from "@everdict/application-control";
import { SandboxSessionService } from "@everdict/application-control";
import type { BudgetTracker, UsageMeter } from "@everdict/domain";
import { canConsumeCapability, harnessAuthEnv, resolveHarnessSecrets } from "@everdict/domain";
import { DockerDriver } from "@everdict/drivers";
import { makeHarness } from "@everdict/job-runner";
import type { HarnessInstanceRegistry, ModelRegistry } from "@everdict/registry";
import { resolveSpecModel } from "../core/execution/model-resolving-dispatcher.js";
import type { ScopedSecretsFn } from "./types.js";

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
  // The playground (harness-target sessions): registry + secrets + model binding compose the resolver here;
  // absent pieces = harness sandboxes 400 while image/environment sessions keep working.
  harnesses?: HarnessInstanceRegistry;
  models?: ModelRegistry;
  scopedSecretsFor?: ScopedSecretsFn;
  budget?: BudgetTracker;
  usage?: UsageMeter;
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
  const { harnesses, models, scopedSecretsFor } = opts;
  // harness ref → a session-ready harness: registry spec (a built-in like claude-code has none — undefined
  // is fine), {secretRef} env resolved from the tenant tiers, the model binding's connection env injected
  // (the same normalization as dispatch), then the concrete EvaluableHarness via makeHarness with
  // sandboxInstall (a bare environment image has no preinstalled CLI). apiKeyEnv picks the harness
  // auth-env vocabulary from the same secret tiers — values stay in process memory only.
  const resolveSessionHarness =
    scopedSecretsFor !== undefined
      ? async (
          tenant: string,
          subject: string,
          ref: { id: string; version?: string },
        ): Promise<ResolvedSessionHarness | undefined> => {
          const spec = harnesses
            ? await harnesses.get(tenant, ref.id, ref.version ?? "latest").catch(() => undefined)
            : undefined;
          const secrets = await scopedSecretsFor(tenant, subject);
          let resolved = spec ? resolveHarnessSecrets(spec, secrets) : undefined;
          if (resolved && models)
            resolved = await resolveSpecModel(models, tenant, subject, resolved, scopedSecretsFor);
          const version = resolved?.version ?? ref.version ?? "latest";
          let harness: ReturnType<typeof makeHarness>;
          try {
            harness = makeHarness(ref.id, version, resolved, { sandboxInstall: true });
          } catch {
            // Not registered AND not a built-in id → the service's 404, not a 400 (missing-secret /
            // model-binding errors above stay loud — those are actionable, this is just "no such harness").
            return undefined;
          }
          return {
            id: ref.id,
            version,
            ...(resolved !== undefined ? { spec: resolved } : {}),
            harness,
            apiKeyEnv: harnessAuthEnv(secrets),
            ...(resolved?.kind === "command" && resolved.image !== undefined ? { image: resolved.image } : {}),
          };
        }
      : undefined;
  return new SandboxSessionService({
    store: opts.store,
    driver: new DockerDriver(),
    ...(opts.trajectories ? { trajectories: opts.trajectories } : {}),
    ...(opts.events ? { events: opts.events } : {}),
    ...(opts.reaper ? { reaper: opts.reaper } : {}),
    ...(resolveSessionHarness ? { resolveSessionHarness } : {}),
    ...(opts.budget ? { budget: opts.budget } : {}),
    ...(opts.usage ? { usage: opts.usage } : {}),
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
