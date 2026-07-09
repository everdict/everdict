import {
  type Backend,
  type BackendRegistry,
  type DispatchOptions,
  type Dispatcher,
  buildRuntimeBackend,
} from "@everdict/backends";
import {
  type AgentJob,
  BadRequestError,
  type CaseResult,
  NotFoundError,
  type RegistryAuth,
  type RuntimeSpec,
  imageUsesRegistryHost,
} from "@everdict/core";
import type { RuntimeRegistry } from "@everdict/registry";
import { jobImages } from "./execute-case.js";
import { type SelfHostedKey, poolKeyFor, selfHostedBackendName } from "./runner-hub.js";

export interface RuntimeDispatcherDeps {
  inner: Dispatcher; // the global Scheduler — fairness/budget/capacity are delegated to it as-is
  backends: BackendRegistry; // the Scheduler's registry — register the built tenant backends here
  runtimes: RuntimeRegistry; // resolve tenant-registered Runtimes
  secretsFor: (tenant: string) => Promise<Record<string, string>>; // SecretStore.entries → backend secretEnv
  // RuntimeSpec → Backend builder (default buildRuntimeBackend = local/docker/nomad/k8s). Backends that @everdict/backends
  // can't depend on (cycle), like topology, are handled by apps/api injecting this (falls back to buildRuntimeBackend).
  buildBackend?: (
    spec: RuntimeSpec,
    opts: { secretEnv?: Record<string, string>; registryAuth?: RegistryAuth },
  ) => Backend;
  // Workspace image-registry pull credentials (best-effort) — carried into the topology backend build for authenticated service-image pulls.
  registryAuthsFor?: (tenant: string) => Promise<RegistryAuth[]>;
  // self:<runnerId> target — a personally-owned self-hosted runner. Not owned = undefined (404), owned = that runner's capabilities[]
  // (ownership check + capability gate in one). A service harness needs the docker capability (gate below).
  resolveSelfRunner?: (owner: string, runnerId: string) => Promise<string[] | undefined>;
  // self:ws (no runner id) pool target — whether that owner (=ws:<tenant>) has any runner at all. Any runner leases it.
  poolHasRunners?: (owner: string) => Promise<boolean>;
  // SelfHostedKey → Backend (Slice 2 stub → Slice 3 lease queue). If not injected, self: falls back to the normal path (not configured).
  buildSelfHostedBackend?: (key: SelfHostedKey) => Backend;
}

// If placement.target is "a Runtime the tenant registered": build a Backend from that spec + the tenant's secrets, register it in the
// Scheduler registry (under the name rt:tenant:id@version), and rewrite target to that name → inner (the Scheduler) routes it.
// Fairness/budget/capacity/isolation are handled by the Scheduler as-is. If target is absent or already a global backend, pass through unchanged (existing behavior).
export class RuntimeDispatcher implements Dispatcher {
  constructor(private readonly deps: RuntimeDispatcherDeps) {}

  async dispatch(job: AgentJob, opts?: DispatchOptions): Promise<CaseResult> {
    const tenant = job.tenant ?? "default";
    const target = job.evalCase.placement?.target;

    // Pool target ("any runner", no runner id, N runners drain):
    //  - self:ws = workspace pool (owner=ws:<tenant> — any member; owner derived from the job's tenant → membership = access).
    //  - self    = personal pool (owner=submitter — any of my runners; several processes/machines can attach to one personal pool).
    // ⚠️ Must come before the self:<runnerId> block below — self:ws could be misread there as runnerId="ws".
    if ((target === "self:ws" || target === "self") && this.deps.poolHasRunners && this.deps.buildSelfHostedBackend) {
      const owner = target === "self:ws" ? `ws:${tenant}` : job.submittedBy;
      if (!owner)
        throw new NotFoundError(
          "NOT_FOUND",
          { resource: "runner", pool: "self" },
          "Using the personal pool (self) requires a submitter — only authenticated requests can target personal runners.",
        );
      if (!(await this.deps.poolHasRunners(owner)))
        throw new NotFoundError(
          "NOT_FOUND",
          { resource: "runner", pool: owner },
          target === "self:ws"
            ? "No shared runner is registered in this workspace — register a shared runner first."
            : "You have no registered runner — pair a runner first.",
        );
      // The service-harness docker requirement is handled by the per-runner capability gate at lease time (requiredRunnerCapabilities maps service→docker).
      const key = poolKeyFor(owner);
      const name = selfHostedBackendName(key);
      if (!this.deps.backends.has(name)) this.deps.backends.register(name, this.deps.buildSelfHostedBackend(key));
      return this.deps.inner.dispatch(
        {
          ...job,
          evalCase: { ...job.evalCase, placement: { ...job.evalCase.placement, target: name } },
        },
        opts,
      );
    }

    // self:<runnerId> — a personally-owned self-hosted runner. Verify the submitter (submittedBy) owns that runner, then
    // route to the (tenant,owner,runnerId) backend. Targeting someone else's runner / an unknown owner is 404 (no existence leak + D3 isolation).
    if (target?.startsWith("self:") && this.deps.resolveSelfRunner && this.deps.buildSelfHostedBackend) {
      // self:ws:<runnerId> = a workspace-shared runner (owner=ws:<tenant> — any member of this workspace can target it; team build server/CI).
      // self:<runnerId> = a personally-owned runner (owner=submitter — my runners only, D3). owner is derived from tenant, so membership is access.
      const rest = target.slice("self:".length);
      const workspaceShared = rest.startsWith("ws:");
      const runnerId = workspaceShared ? rest.slice("ws:".length) : rest;
      const owner = workspaceShared ? `ws:${tenant}` : job.submittedBy;
      const caps = owner && runnerId ? await this.deps.resolveSelfRunner(owner, runnerId) : undefined;
      if (!owner || !runnerId || caps === undefined)
        throw new NotFoundError(
          "NOT_FOUND",
          { runnerId, resource: "runner" },
          workspaceShared
            ? "No shared runner found in this workspace."
            : "Self-hosted runner not found — you can only target runners you own.",
        );
      // A service (topology) harness stands up a local Docker topology, so the runner needs the docker capability — if absent, reject explicitly before running.
      if (job.harnessSpec?.kind === "service" && !caps.includes("docker"))
        throw new BadRequestError(
          "BAD_REQUEST",
          { runnerId, need: "docker", have: caps },
          "This self-hosted runner can't run service (topology) harnesses — it lacks the docker capability (install Docker and restart the runner).",
        );
      // No tenant in the key — a runner receives jobs from its owner's multiple workspaces on one queue (cross-workspace). The job carries the tenant.
      const key: SelfHostedKey = { owner, runnerId };
      const name = selfHostedBackendName(key);
      if (!this.deps.backends.has(name)) this.deps.backends.register(name, this.deps.buildSelfHostedBackend(key));
      return this.deps.inner.dispatch(
        {
          ...job,
          evalCase: { ...job.evalCase, placement: { ...job.evalCase.placement, target: name } },
        },
        opts,
      );
    }

    let routed = job;
    // If target is a global backend name, use it as-is (existing static backend). Otherwise try to resolve it as a tenant Runtime.
    if (target && !this.deps.backends.has(target)) {
      const spec = await this.deps.runtimes.get(tenant, target).catch(() => undefined);
      if (spec) {
        const name = `rt:${tenant}:${spec.id}@${spec.version}`; // one backend instance per tenant·version (reused)
        if (!this.deps.backends.has(name)) {
          const secretEnv = await this.deps.secretsFor(tenant).catch(() => ({}) as Record<string, string>);
          // Workspace registry (plural) pull credentials — bake the one matching this job image's host into the backend
          // (the backend is built once per runtime and reused — based on the first build job; a documented limit of the single-value contract).
          const auths = (await this.deps.registryAuthsFor?.(tenant).catch(() => [])) ?? [];
          const images = jobImages(job);
          const registryAuth = auths.find((a) => images.some((image) => imageUsesRegistryHost(image, a.host)));
          const build = this.deps.buildBackend ?? buildRuntimeBackend;
          this.deps.backends.register(name, build(spec, { secretEnv, ...(registryAuth ? { registryAuth } : {}) }));
        }
        routed = { ...job, evalCase: { ...job.evalCase, placement: { ...job.evalCase.placement, target: name } } };
      }
      // If the spec isn't found, keep target as-is → the Scheduler fails NOT_FOUND on the unregistered backend (explicit failure).
    }
    return this.deps.inner.dispatch(routed, opts);
  }
}
