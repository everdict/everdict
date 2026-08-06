import type {
  CapabilityService,
  CapabilityStore,
  EnvelopeStore,
  PlatformEventEmitter,
  ResolvedDelegationProfile,
  ResolvedServiceConversation,
  ResolvedSessionHarness,
  RunStore,
  SandboxSessionServiceDeps,
  TrajectoryStore,
  WorkspaceImages,
} from "@everdict/application-control";
import { type GithubAppService, SandboxSessionService } from "@everdict/application-control";
import { BadRequestError, NotFoundError, type RegistryAuth } from "@everdict/contracts";
import type { BudgetTracker, TrustZonePolicy, UsageMeter } from "@everdict/domain";
import {
  assertHardenedIsolation,
  canConsumeCapability,
  harnessAuthEnv,
  parseImageRef,
  resolveEnvValues,
  resolveHarnessSecrets,
} from "@everdict/domain";
import { makeHarness } from "@everdict/job-runner";
import type { HarnessInstanceRegistry, ModelRegistry } from "@everdict/registry";
import { FrontDoorSession, type ServiceTopologyBackendOptions } from "@everdict/topology";
import type { RuntimeCompute } from "../common/runtime-compute.js";
import { resolveModelConnectionEnv, resolveSpecModel } from "../core/execution/model-resolving-dispatcher.js";
import type { DeploymentCompute } from "./compute-env.js";
import type { ScopedSecretsFn } from "./types.js";

// Sandbox session runs (execution-model P6) are OPT-IN infrastructure, exactly like file execution: the lane
// exists only where the operator asked for compute (`EVERDICT_COMPUTE`, or this lane's own
// `EVERDICT_SANDBOX_DRIVER`). Everywhere else the routes and the tools are simply absent. Caps default CLOSED-ish (2 per tenant / 8 total) — a session is a scarcer resource than
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
  // The gate's causal leg (§5.1): an agent's session draws from its turn's delegated envelope.
  envelopes?: EnvelopeStore;
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
  // W4: publish a captured work tree as a layer on the session's base image (registry API only, no daemon).
  publishLayerSnapshot?: SandboxSessionServiceDeps["publishLayerSnapshot"];
  // The operator's isolation policy — applied to a cluster-placed session exactly as to a dispatched case.
  trustZones?: TrustZonePolicy;
  // Front-door conversations (service harnesses): tenant runtime ref → the SHARED topology environment (the
  // same memoized TopologyRuntime + trace/rendezvous seams the eval lane dispatches through — one warm pool).
  // Absent = service harnesses fall through to the process resolver's honest 404/400.
  topologyConversationEnvironmentFor?: (
    tenant: string,
    runtimeId: string,
    imageRefs: string[],
  ) => Promise<ServiceTopologyBackendOptions>;
  // WHERE work runs, for every lane that asks (composition/runtime-compute): the deployment's own compute, and
  // a tenant's registered runtime resolved with its cluster credentials and trust zone. A session can be placed
  // on the workspace's own cluster — the same axis a run's placement.target names.
  compute: RuntimeCompute;
  // Whether THIS lane is on, from the one compute block (composition/compute-env) rather than an env read here.
  deployment?: DeploymentCompute;
}): SandboxSessionService | undefined {
  // WHERE a session's container lives. `docker` is this host (dev, and the fastest snapshot — the driver can
  // commit); `nomad` places it on a cluster, which is what takes worlds off the control-plane host. The
  // cluster backend cannot reach a daemon, so its snapshots go through the registry layer-append path — which
  // is why that had to exist first (docs/architecture/agent-worlds.md §W4).
  if (!opts.deployment?.sandboxes) return undefined;
  const driver = opts.compute.defaultCompute;
  if (driver === undefined) {
    console.warn("▶ sandbox sessions: compute is configured but this deployment has none it can hold open");
    return undefined;
  }
  console.log(`▶ sandbox sessions: ${driver.id} (POST /sandboxes + create_sandbox)`);
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
            // The web's UI branch: "command" = a declarative CLI spec; everything else this resolver serves
            // (built-ins like claude-code, spec-less refs) is a "process" harness adapter.
            kind: resolved?.kind === "command" ? ("command" as const) : ("process" as const),
            ...(resolved !== undefined ? { spec: resolved } : {}),
            harness,
            apiKeyEnv: harnessAuthEnv(secrets),
            ...(resolved?.kind === "command" && resolved.image !== undefined ? { image: resolved.image } : {}),
          };
        }
      : undefined;
  // Delegation profiles: a `delegation` capability ref → the registered WORK ENVIRONMENT everdict hands work
  // to. One reference collapses what a delegation otherwise re-specifies every time — the image, which
  // conversational agent runs, the model connection, the env/secrets and the standing instructions — because a
  // process harness's own spec is {kind,id,version} and can carry none of it. Env precedence, stated once:
  // harnessAuthEnv(workspace→personal tiers) < the profile's own env < the model's connection env.
  const { models: modelRegistry } = opts;
  const resolveDelegationProfile =
    capabilities !== undefined && scopedSecretsFor !== undefined
      ? async (
          tenant: string,
          subject: string,
          ref: { source?: string; id: string; version?: string },
        ): Promise<ResolvedDelegationProfile | undefined> => {
          const record = await capabilities.get(ref.source ?? tenant, ref.id, ref.version).catch(() => undefined);
          if (!record || record.spec.type !== "delegation") return undefined;
          if (!canConsumeCapability(record, { tenant, subject })) return undefined; // no existence leak
          const profile = record.spec;
          const secrets = await scopedSecretsFor(tenant, subject);
          const missing = new Set<string>();
          const profileEnv = resolveEnvValues(profile.env, secrets, missing);
          if (missing.size > 0)
            throw new BadRequestError(
              "BAD_REQUEST",
              { profile: record.id, missing: [...missing] },
              `Delegation profile '${record.id}' needs secret(s) this workspace has not set: ${[...missing].join(", ")}.`,
            );
          // The model's connection wins over a profile literal — the same "model wins" rule the eval lane's
          // spec resolution applies, so a profile and a harness never disagree about who owns the endpoint.
          const modelEnv =
            modelRegistry !== undefined && profile.model !== undefined
              ? await resolveModelConnectionEnv(modelRegistry, tenant, subject, profile.model, scopedSecretsFor)
              : {};
          const workDir = profile.workDir ?? "work";
          const harness = makeHarness(profile.harness.id, profile.harness.version ?? "latest", undefined, {
            sandboxInstall: true,
            env: { ...profileEnv, ...modelEnv },
            workDir,
          });
          if (harness.conversational !== true)
            throw new BadRequestError(
              "BAD_REQUEST",
              { profile: record.id, harness: profile.harness.id },
              `Delegation profile '${record.id}' runs '${profile.harness.id}', which cannot hold a conversation — a delegate you can only message once cannot be handed work.`,
            );
          return {
            ref: { source: record.tenant, id: record.id, version: record.version },
            harness: {
              id: profile.harness.id,
              version: profile.harness.version ?? "latest",
              kind: "process",
              harness,
              apiKeyEnv: harnessAuthEnv(secrets),
            },
            image: profile.image,
            workDir,
            instructions: profile.instructions,
            instructionsFile: profile.instructionsFile,
            ...(profile.ttlSec !== undefined ? { ttlSec: profile.ttlSec } : {}),
          };
        }
      : undefined;
  // Front-door conversations: a kind:"service" harness ref → a bootable multi-turn conversation over its
  // front-door, placed on a REGISTERED workspace runtime (the user decision — no control-plane topology).
  // Kind is checked FIRST (this is also what fixes the old misleading 404: a service harness used to fall into
  // makeHarness, throw, and read as "not found"); a non-service ref returns undefined so the process resolver
  // answers. The spec is secret- AND model-resolved exactly like the dispatch lane, so both lanes deploy a
  // byte-identical topology into the same warm-pool key.
  const conversationEnvFor = opts.topologyConversationEnvironmentFor;
  const resolveServiceConversation =
    scopedSecretsFor !== undefined && harnesses !== undefined && conversationEnvFor !== undefined
      ? async (
          tenant: string,
          subject: string,
          ref: { id: string; version?: string },
          o: { runtime?: string },
        ): Promise<ResolvedServiceConversation | undefined> => {
          const spec = harnesses
            ? await harnesses.get(tenant, ref.id, ref.version ?? "latest").catch(() => undefined)
            : undefined;
          if (!spec || spec.kind !== "service") return undefined;
          if (o.runtime === undefined)
            throw new BadRequestError(
              "BAD_REQUEST",
              { harness: ref.id },
              "A service-topology harness session runs on a registered runtime — provide `runtime`.",
            );
          const secrets = await scopedSecretsFor(tenant, subject);
          let resolved = resolveHarnessSecrets(spec, secrets);
          if (models) resolved = await resolveSpecModel(models, tenant, subject, resolved, scopedSecretsFor);
          if (resolved.kind !== "service") return undefined; // resolution preserves kind — narrow only
          const resolvedSpec = resolved;
          const env = await conversationEnvFor(
            tenant,
            o.runtime,
            resolvedSpec.services.map((s) => s.image).filter((image): image is string => image !== undefined),
          );
          const zone = opts.trustZones?.resolve(tenant);
          if (zone) assertHardenedIsolation(zone);
          const frontDoorImage = resolvedSpec.services.find((s) => s.name === resolvedSpec.frontDoor.service)?.image;
          const traceSourceFor = env.traceSourceFor;
          return {
            harness: { id: ref.id, version: resolvedSpec.version },
            ...(frontDoorImage !== undefined ? { frontDoorImage } : {}),
            open: (sessionRunId) =>
              new FrontDoorSession({
                spec: resolvedSpec,
                sessionRunId,
                runtime: env.runtime,
                traceSource: env.traceSource,
                ...(traceSourceFor !== undefined ? { traceSourceFor: () => traceSourceFor(tenant, ref.id) } : {}),
                ...(env.callbackRendezvous !== undefined ? { callbackRendezvous: env.callbackRendezvous } : {}),
                ...(zone !== undefined ? { zone } : {}),
              }),
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
  // Retention (W3): a world gains a version per hibernate and the registry has no GC, so the line is bounded
  // by operator policy — capability versions AND the image bytes behind them, because dropping only the
  // version would leave the registry holding blobs nobody can name. Image removal is per-version
  // best-effort: a tag already gone is the desired state, not a failure.
  const keepVersions = intEnv("EVERDICT_WORLD_KEEP_VERSIONS") ?? 10;
  const images = opts.images;
  const pruneWorldVersions =
    capabilityService !== undefined
      ? async (
          tenant: string,
          actor: { subject: string; isAdmin: boolean },
          world: string,
        ): Promise<{ prunedVersions: string[] }> => {
          const { pruned, skipped } = await capabilityService.pruneVersions(tenant, world, actor, keepVersions);
          for (const entry of pruned) {
            const tag = entry.image !== undefined ? parseImageRef(entry.image).tag : undefined;
            if (tag !== undefined && images) await images.remove(tenant, world, tag).catch(() => 0);
          }
          if (skipped.length > 0)
            console.warn(
              `▶ world retention: kept ${skipped.length} version(s) of '${world}' published by another member (${skipped.join(", ")})`,
            );
          return { prunedVersions: pruned.map((p) => p.version) };
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
  // A session on the WORKSPACE's own runtime — the resolver shared with file execution and the browser lane,
  // so which cluster, which credential and which trust zone have one answer for all of them.
  const driverFor = (tenant: string, runtime: string) => opts.compute.computeFor(tenant, runtime);
  return new SandboxSessionService({
    store: opts.store,
    driver,
    driverFor,
    ...(git ? { git } : {}),
    ...(opts.trajectories ? { trajectories: opts.trajectories } : {}),
    ...(opts.events ? { events: opts.events } : {}),
    ...(opts.reaper ? { reaper: opts.reaper } : {}),
    ...(opts.images ? { images: opts.images } : {}),
    ...(opts.publishLayerSnapshot ? { publishLayerSnapshot: opts.publishLayerSnapshot } : {}),
    ...(intEnv("EVERDICT_WORLD_MAX_CAPTURE_BYTES") !== undefined
      ? { maxCaptureBytes: intEnv("EVERDICT_WORLD_MAX_CAPTURE_BYTES") }
      : {}),
    ...(opts.registryAuthsFor ? { resolvePullAuths: opts.registryAuthsFor } : {}),
    ...(publishWorldVersion ? { publishWorldVersion } : {}),
    ...(pruneWorldVersions ? { pruneWorldVersions } : {}),
    ...(resolveSessionHarness ? { resolveSessionHarness } : {}),
    ...(resolveServiceConversation ? { resolveServiceConversation } : {}),
    ...(resolveDelegationProfile ? { resolveDelegationProfile } : {}),
    ...(opts.budget ? { budget: opts.budget } : {}),
    ...(opts.envelopes ? { envelopes: opts.envelopes } : {}),
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
    // W3: one live session per agent by default, and the tenant's last slot stays reserved for a member —
    // an autonomous world loop must not be able to starve the person trying to open a shell.
    maxPerAgent: intEnv("EVERDICT_SANDBOX_MAX_PER_AGENT") ?? 1,
    maxTotal: intEnv("EVERDICT_SANDBOX_MAX_TOTAL") ?? 8,
    // The front-door conversation pool's own caps — a warm-topology slot on a tenant cluster is a different
    // scarcity than a control-plane container, so the pools never share.
    frontdoorMaxPerTenant: intEnv("EVERDICT_FRONTDOOR_MAX_PER_TENANT") ?? 2,
    frontdoorMaxTotal: intEnv("EVERDICT_FRONTDOOR_MAX_TOTAL") ?? 8,
    ...(intEnv("EVERDICT_SANDBOX_TTL_SEC") !== undefined ? { defaultTtlSec: intEnv("EVERDICT_SANDBOX_TTL_SEC") } : {}),
  });
}

function intEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
