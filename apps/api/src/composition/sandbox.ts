import type {
  CapabilityService,
  CapabilityStore,
  PlatformEventEmitter,
  ResolvedSessionHarness,
  RunStore,
  SandboxSessionServiceDeps,
  TrajectoryStore,
  WorkspaceImages,
} from "@everdict/application-control";
import { type GithubAppService, SandboxSessionService } from "@everdict/application-control";
import { NotFoundError, type RegistryAuth } from "@everdict/contracts";
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
  // Agent worlds (W1): the managed image store snapshots publish into, and the capability service that
  // registers each snapshot as an environment-capability version. Either absent = world sessions 400.
  images?: WorkspaceImages;
  capabilityService?: CapabilityService;
  // Image pull credentials — the same `buildImagePullAuths` seam the dispatch lane uses. A session booting a
  // world snapshot (or any managed-store environment) pulls from our own registry, which requires a grant.
  registryAuthsFor?: (workspace: string, imageRefs: string[]) => Promise<RegistryAuth[]>;
  // Agent worlds (W2): the workspace GitHub App, bound behind the service's `git` seam (peer services never
  // call each other). Absent = clone-in works only for public repos and pushing 400s.
  githubApp?: GithubAppService;
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
  // Agent worlds (W1): a snapshot bumps the world's IMAGE, not its identity — name/description/instructions
  // carry forward from the latest version unless this snapshot restates them, so an auto-hibernate can never
  // blank out prose the author wrote. Genesis (no prior version) gets honest provenance defaults.
  const { capabilityService } = opts;
  const publishWorldVersion =
    capabilityService !== undefined
      ? async (
          tenant: string,
          actor: { subject: string; isAdmin: boolean },
          world: string,
          input: { image: string; sessionRunId: string; name?: string; description?: string; instructions?: string },
        ): Promise<{ version: string }> => {
          const latest = capabilities
            ? await capabilities.get(tenant, world, "latest").catch(() => undefined)
            : undefined;
          const prior = latest?.spec.type === "environment" ? latest.spec : undefined;
          const saved = await capabilityService.save(tenant, actor, world, {
            name: input.name ?? latest?.name ?? world,
            description:
              input.description ??
              latest?.description ??
              `Agent world '${world}' — filesystem snapshots of its sandbox sessions.`,
            spec: {
              type: "environment",
              image: input.image,
              ...(prior?.contents !== undefined ? { contents: prior.contents } : {}),
              ...(prior?.preset !== undefined ? { preset: prior.preset } : {}),
              instructions:
                input.instructions ??
                prior?.instructions ??
                `Snapshot of sandbox session ${input.sessionRunId}. Boot it with create_sandbox world:{id:"${world}"} to continue from this state.`,
            },
          });
          return { version: saved.version };
        }
      : undefined;
  // Agent worlds (W2): read and write are separate calls into the App service so a clone never holds a
  // credential that could push, and a push mints its own at the moment it is needed. A repository no
  // installation covers is a 404 with the repo named — the actionable answer ("install the App there").
  const { githubApp } = opts;
  const repoRef = (gitUrl: string): { repository: string; host?: string } => {
    const ref = githubApp?.repoRefFromGitUrl(gitUrl);
    if (!ref)
      throw new NotFoundError(
        "NOT_FOUND",
        { git: gitUrl },
        `'${gitUrl}' is not a repository URL this workspace can reach.`,
      );
    return ref;
  };
  const git: SandboxSessionServiceDeps["git"] =
    githubApp !== undefined
      ? {
          readToken: (tenant, gitUrl) => githubApp.tokenForRepo(tenant, gitUrl),
          writeToken: async (tenant, gitUrl) => {
            const { repository, host } = repoRef(gitUrl);
            const { token } = await githubApp.tokenForRepository(tenant, repository, { contents: "write" }, host);
            return token;
          },
          openPullRequest: (tenant, gitUrl, input) => {
            const { repository, host } = repoRef(gitUrl);
            return githubApp.openPullRequestForBranch(tenant, repository, input, host);
          },
        }
      : undefined;
  return new SandboxSessionService({
    store: opts.store,
    driver: new DockerDriver(),
    ...(git ? { git } : {}),
    ...(opts.trajectories ? { trajectories: opts.trajectories } : {}),
    ...(opts.events ? { events: opts.events } : {}),
    ...(opts.reaper ? { reaper: opts.reaper } : {}),
    ...(opts.images ? { images: opts.images } : {}),
    ...(opts.registryAuthsFor ? { resolvePullAuths: opts.registryAuthsFor } : {}),
    ...(publishWorldVersion ? { publishWorldVersion } : {}),
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
