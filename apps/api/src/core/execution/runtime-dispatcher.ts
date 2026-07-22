import { type SelfHostedKey, poolKeyFor, selfHostedBackendName } from "@everdict/application-control";
import { jobImages } from "@everdict/application-control";
import {
  type Backend,
  type BackendRegistry,
  type DispatchOptions,
  type Dispatcher,
  buildRuntimeBackend,
} from "@everdict/backends";
import {
  BadRequestError,
  type CaseJob,
  type CaseResult,
  NotFoundError,
  type RegistryAuth,
  type RuntimeSpec,
} from "@everdict/contracts";
import { capabilityKind, imageUsesRegistryHost, requiredCapabilitiesForJob, runtimeSatisfies } from "@everdict/domain";
import type { RuntimeRegistry } from "@everdict/registry";

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
  // self:<runnerId> target — a personally-owned self-hosted runner. Not owned = undefined (404), owned = its liveness
  // (advertised capabilities + whether it's ONLINE right now). Capabilities gate placement; `online` drives the
  // dispatch-time "runner offline" diagnostic. A service harness needs the docker capability (gate below).
  resolveSelfRunner?: (owner: string, runnerId: string) => Promise<RunnerLiveness | undefined>;
  // self:ws / self (no runner id) pool target — the liveness of every runner in that owner's pool (=ws:<tenant> for a
  // workspace pool, =submitter for a personal pool). Empty = no runner at all (404). Used for three dispatch-time
  // gates: (1) pool non-empty, (2) SOME runner advertises the required capabilities (else the job would park unleased
  // until the generic idle timeout — the lease-time gate only SKIPS per runner, naming nothing), and (3) at least one
  // CAPABLE runner is ONLINE (else surface "your runner(s) are offline" immediately instead of a silent 5-min wait).
  poolRunners?: (owner: string) => Promise<RunnerLiveness[]>;
  // SelfHostedKey → Backend (Slice 2 stub → Slice 3 lease queue). If not injected, self: falls back to the normal path (not configured).
  buildSelfHostedBackend?: (key: SelfHostedKey) => Backend;
}

// A self-hosted runner's dispatch-relevant liveness: what it can run (advertised, refreshed on every lease) and
// whether it's reachable RIGHT NOW (lastSeenAt within the online window — see @everdict/domain isRunnerOnline).
// `label` is the runner's display name, used to name it in the "runner offline" diagnostic.
export interface RunnerLiveness {
  capabilities: string[];
  online: boolean;
  label?: string;
}

// Name the (offline) capable runners for the "no online runner" diagnostic — bounded so a large pool doesn't produce
// a wall of text. Labels fall back to a generic word when unnamed (never leaks an internal id).
function poolRunnerNames(runners: RunnerLiveness[]): string {
  const labels = runners.map((r) => r.label).filter((l): l is string => l !== undefined && l.length > 0);
  if (labels.length === 0) return `${runners.length} runner${runners.length === 1 ? "" : "s"}`;
  if (labels.length <= 3) return labels.join(", ");
  return `${labels.slice(0, 3).join(", ")} and ${labels.length - 3} more`;
}

// If placement.target is "a Runtime the tenant registered": build a Backend from that spec + the tenant's secrets, register it in the
// Scheduler registry (under the name rt:tenant:id@version), and rewrite target to that name → inner (the Scheduler) routes it.
// Fairness/budget/capacity/isolation are handled by the Scheduler as-is. If target is absent or already a global backend, pass through unchanged (existing behavior).
export class RuntimeDispatcher implements Dispatcher {
  constructor(private readonly deps: RuntimeDispatcherDeps) {}

  // Drop this tenant's cached runtime backends so the next dispatch rebuilds them with fresh secrets.
  // Without this, a backend built once per (tenant, runtime@version) keeps its secretEnv until a CP restart —
  // a workspace secret change (e.g. the judge's provider key) silently never reached running deployments.
  invalidateTenant(tenant: string): void {
    const prefix = `rt:${tenant}:`;
    for (const name of this.deps.backends.names()) {
      if (name.startsWith(prefix)) this.deps.backends.unregister(name);
    }
  }

  // Drop a revoked runner's lazily-registered self:<owner>:<runnerId> Backend. The dispatch path registers one
  // Backend per pinned runner on first use and never removed it, so runner churn (pair→run→revoke) leaked one
  // Backend per runner in the placement registry. Wired to RunnerService.onRevoke. No-op if never registered
  // (a runner that only took pool jobs) — the pool backend (self:<owner>:*) is shared and stays.
  unregisterSelfRunnerBackend(owner: string, runnerId: string): void {
    this.deps.backends.unregister(selfHostedBackendName({ owner, runnerId }));
  }

  async dispatch(job: CaseJob, opts?: DispatchOptions): Promise<CaseResult> {
    const tenant = job.tenant ?? "default";
    const target = job.evalCase.placement?.target;

    // Pool target ("any runner", no runner id, N runners drain):
    //  - self:ws = workspace pool (owner=ws:<tenant> — any member; owner derived from the job's tenant → membership = access).
    //  - self    = personal pool (owner=submitter — any of my runners; several processes/machines can attach to one personal pool).
    // ⚠️ Must come before the self:<runnerId> block below — self:ws could be misread there as runnerId="ws".
    if ((target === "self:ws" || target === "self") && this.deps.poolRunners && this.deps.buildSelfHostedBackend) {
      const owner = target === "self:ws" ? `ws:${tenant}` : job.submittedBy;
      if (!owner)
        throw new NotFoundError(
          "NOT_FOUND",
          { resource: "runner", pool: "self" },
          "Using the personal pool (self) requires a submitter — only authenticated requests can target personal runners.",
        );
      const runners = await this.deps.poolRunners(owner);
      if (runners.length === 0)
        throw new NotFoundError(
          "NOT_FOUND",
          { resource: "runner", pool: owner },
          target === "self:ws"
            ? "No shared runner is registered in this workspace — register a shared runner first."
            : "You have no registered runner — pair a runner first.",
        );
      // Per-runner capability details stay a lease-time concern (each runner skips what it can't run) — but when
      // NO runner in the pool advertises a required FUNCTIONAL capability, the job would park unleased until the
      // generic idle timeout. Fail fast at dispatch instead, naming what's missing (mirror of the pinned-runner gate).
      const need = requiredCapabilitiesForJob(job).filter((c) => capabilityKind(c) === "functional");
      const capable = need.length > 0 ? runners.filter((r) => need.every((c) => r.capabilities.includes(c))) : runners;
      if (need.length > 0 && capable.length === 0) {
        const advertised = [...new Set(runners.flatMap((r) => r.capabilities))];
        throw new BadRequestError(
          "BAD_REQUEST",
          { pool: target, need, advertised },
          `No runner in the ${target} pool advertises the capabilities this job requires [${need.join(", ")}] (the pool advertises [${advertised.join(", ")}]). Connect a runner that provides them (capabilities refresh on each lease) or target a runtime that does.`,
        );
      }
      // Capable runner(s) exist but ALL are offline right now → the job would park silently until a runner reconnects
      // (or the 5-min idle timeout). Surface the reason immediately (non-terminal — it still parks and runs the moment
      // a runner comes back). Distinct from "no capable runner" (a hard 400) because this CAN succeed on reconnect.
      if (!capable.some((r) => r.online)) {
        const names = poolRunnerNames(capable);
        opts?.onWaiting?.(
          `No online runner in the ${target} pool — the runner(s) that can run this job (${names}) are offline. Start or reconnect one; this case is waiting and will begin automatically once a runner is back (or fail after ~5 min).`,
        );
      }
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
      const runner = owner && runnerId ? await this.deps.resolveSelfRunner(owner, runnerId) : undefined;
      if (!owner || !runnerId || runner === undefined)
        throw new NotFoundError(
          "NOT_FOUND",
          { runnerId, resource: "runner" },
          workspaceShared
            ? "No shared runner found in this workspace."
            : "Self-hosted runner not found — you can only target runners you own.",
        );
      // A service (topology) harness stands up a local Docker topology, so the runner needs the docker capability — if absent, reject explicitly before running.
      if (job.harnessSpec?.kind === "service" && !runner.capabilities.includes("docker"))
        throw new BadRequestError(
          "BAD_REQUEST",
          { runnerId, need: "docker", have: runner.capabilities },
          "This self-hosted runner can't run service (topology) harnesses — it lacks the docker capability (install Docker and restart the runner).",
        );
      // The pinned runner is offline right now → the job would park silently until it reconnects (or the 5-min idle
      // timeout). Surface the reason immediately (non-terminal — it still parks and runs the moment the runner is back).
      if (!runner.online)
        opts?.onWaiting?.(
          `Runner "${runner.label ?? runnerId}" is offline (no lease in the last ~90s) — start or reconnect it. This case is waiting and will begin automatically once it's back (or fail after ~5 min).`,
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
        // Capability placement gate: reject a job the runtime can't run BEFORE dispatching. Without it a mismatch
        // (e.g. a Windows-service topology on a Linux-only cluster) is accepted by the orchestrator and the service
        // sits constraint-filtered / pending forever. runtimeSatisfies is a no-op for a runtime that declared no
        // capabilities (backward-compat); it bites only once the operator labels the runtime (e.g. with os-windows).
        const required = requiredCapabilitiesForJob(job);
        if (!runtimeSatisfies(spec.capabilities, required)) {
          throw new BadRequestError(
            "BAD_REQUEST",
            { runtime: `${spec.id}@${spec.version}`, need: required, have: spec.capabilities ?? [] },
            `Runtime "${spec.id}" can't run this job — it lacks required capabilities [${required.join(", ")}] (it advertises [${(spec.capabilities ?? []).join(", ")}]). Choose a runtime whose nodes provide them (e.g. an os-windows-capable cluster for a Windows service).`,
          );
        }
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
