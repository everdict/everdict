import { CiLinkService } from "@everdict/application-control";
import type { GithubAppService, VerifierRunner } from "@everdict/application-control";
import { MattermostCommandService } from "@everdict/application-control";
import type { TenantValueMap } from "@everdict/application-control";
import { QueueService } from "@everdict/application-control";
import type { RunnerService } from "@everdict/application-control";
import type { ScheduleService } from "@everdict/application-control";
import type { ScorecardService } from "@everdict/application-control";
import type { AgentRegistry } from "@everdict/application-control";
import { SubscriptionService } from "@everdict/application-control";
import { CheckpointService } from "@everdict/application-control";
import type {
  HandoffCheckpointStore,
  IssueStore,
  PlatformEventEmitter,
  VerificationDecisionStore,
} from "@everdict/application-control";
import { ViewService } from "@everdict/application-control";
import { ViewSnapshotService } from "@everdict/application-control";
import type { WorkspaceFs } from "@everdict/application-control";
import { BrowserProfileService } from "@everdict/application-control";
import type { Scheduler } from "@everdict/backends";
import type { AgentSpec } from "@everdict/contracts";
import type {
  BrowserProfileStore,
  RunStore,
  ScorecardStore,
  SecretStore,
  SubscriptionStore,
  ViewStore,
  WorkspaceSettingsStore,
} from "@everdict/db";
import type { EvidenceIdentity } from "@everdict/domain";
import { contentDigest } from "@everdict/domain";
import type { CircuitBreaker } from "@everdict/domain";
import type {
  BenchmarkRegistry,
  DatasetRegistry,
  HarnessInstanceRegistry,
  HarnessTemplateRegistry,
  JudgeRegistry,
  ModelRegistry,
  RubricRegistry,
  RuntimeRegistry,
} from "@everdict/registry";
import { AgentService } from "../core/agent/agent-service.js";
import { BenchmarkService } from "../core/benchmark/benchmark-service.js";
import { BundleService } from "../core/bundle/bundle-service.js";
import { githubRepoWriterFactory } from "../infrastructure/github/repo-writer.js";
import type { RuntimeSecretsFn } from "./types.js";

// Chat inbound: Mattermost slash commands / buttons → run a scorecard, or read the leaderboard from chat.
export function buildMattermostCommand(deps: {
  settingsStore: WorkspaceSettingsStore;
  runtimeSecretsFor: RuntimeSecretsFn;
  scorecardService: ScorecardService;
}): MattermostCommandService {
  const { settingsStore, runtimeSecretsFor, scorecardService } = deps;
  // Mattermost inbound (slash commands/buttons) — after commandToken verification, run a scorecard / view the leaderboard from chat.
  return new MattermostCommandService({
    settings: settingsStore,
    secretsFor: runtimeSecretsFor, // resolve (verify) the commandTokenSecretName value — a workspace shared secret
    submitScorecard: async (workspace, { dataset, harness, submittedBy }) => {
      const rec = await scorecardService.submit({
        tenant: workspace,
        submittedBy,
        dataset: { id: dataset, version: "latest" },
        harness: { id: harness, version: "latest" },
        origin: { source: "mattermost" },
      });
      return { id: rec.id };
    },
    leaderboard: async (workspace, datasetId) => {
      // Metric resolved from the dataset's own cards (preferredMetric) — the hardcoded "tests_pass" gave a
      // silently empty board to any workspace whose graders summarize under other names.
      const lb = await scorecardService.leaderboard(workspace, { datasetId });
      return lb.rows.map((r) => ({
        label: `${r.harness.id}@${r.harness.version}`,
        value: r.score !== null ? r.score.toFixed(3) : "—",
      }));
    },
    webBaseUrl: process.env.WEB_BASE_URL ?? "http://localhost:3001",
  });
}

// Benchmark catalog import + one-shot bundle install. Both fan out over the existing registries; no new store.
export function buildCatalog(deps: {
  datasetRegistry: DatasetRegistry;
  benchmarkRegistry: BenchmarkRegistry;
  harnessTemplateRegistry: HarnessTemplateRegistry;
  harnessInstanceRegistry: HarnessInstanceRegistry;
  judgeRegistry: JudgeRegistry;
  rubricRegistry: RubricRegistry;
  modelRegistry: ModelRegistry;
  runtimeRegistry: RuntimeRegistry;
  secretStore: SecretStore;
}) {
  const {
    datasetRegistry,
    benchmarkRegistry,
    harnessTemplateRegistry,
    harnessInstanceRegistry,
    judgeRegistry,
    rubricRegistry,
    modelRegistry,
    runtimeRegistry,
    secretStore,
  } = deps;
  // Benchmark catalog import: pull a first-party benchmark by ID alone and register it as a tenant dataset. Gated ones use the HF_TOKEN secret.
  const benchmarkService = new BenchmarkService({
    datasets: datasetRegistry,
    benchmarks: benchmarkRegistry,
    // Gated HF auth — the requester's "personal" secret first, workspace-shared fallback. A member can, without an admin,
    // just put HF_TOKEN in their account secrets and self-serve import a gated benchmark from the web.
    secretsFor: async (tenant, subject) => {
      const scoped = await secretStore.scopedEntries(tenant, subject ?? "");
      return { ...scoped.workspace, ...scoped.user };
    },
  });
  // Bundle one-shot install — fan out over the existing registries (harness + benchmark + dataset + runtime + judge/model). No new store.
  const bundleService = new BundleService({
    harnessTemplates: harnessTemplateRegistry,
    harnessInstances: harnessInstanceRegistry,
    benchmarks: benchmarkRegistry,
    datasets: datasetRegistry,
    judges: judgeRegistry,
    rubrics: rubricRegistry,
    models: modelRegistry,
    runtimes: runtimeRegistry,
  });
  return { benchmarkService, bundleService };
}

// CI repo link — repo↔harness-slot mapping (= GitHub Actions OIDC trust) CRUD + repo picker + setup-PR generator.
export function buildCiLink(deps: {
  settingsStore: WorkspaceSettingsStore;
  githubAppService: GithubAppService;
  runnerService: RunnerService;
}): CiLinkService {
  const { settingsStore, githubAppService, runnerService } = deps;
  // The picker/setup-PR use the member's personal GitHub connection token (tokenFor) only server-side.
  return new CiLinkService({
    settings: settingsStore,
    repoWriter: githubRepoWriterFactory(), // outbound branch/file/PR adapter (fetch)
    githubApp: githubAppService, // repo picker + setup-PR + runner registration token = the workspace GitHub App (replaces personal connections)
    runners: runnerService, // setup-PR checks the self:ws pool exists (D6 — CI placement is always self-hosted, fail-closed)
    ...(process.env.API_PUBLIC_URL ? { apiPublicUrl: process.env.API_PUBLIC_URL } : {}), // api-url of the generated workflow
  });
}

// Work queue snapshot — what is running/waiting where (runtime lane) right now, and what the next scheduled fire is (read-only visibility).
export function buildQueue(deps: {
  scorecardStore: ScorecardStore;
  runStore: RunStore;
  scheduleService: ScheduleService;
  runtimeRegistry: RuntimeRegistry;
  datasetRegistry: DatasetRegistry;
  runnerService: RunnerService;
  scheduler: Scheduler;
  breaker: CircuitBreaker;
  tenantQuotas: TenantValueMap | undefined;
}): QueueService {
  const {
    scorecardStore,
    runStore,
    scheduleService,
    runtimeRegistry,
    datasetRegistry,
    runnerService,
    scheduler,
    breaker,
    tenantQuotas,
  } = deps;
  return new QueueService({
    scorecards: scorecardStore,
    runs: runStore,
    schedules: scheduleService,
    runtimes: runtimeRegistry,
    // Personal queue scope — expose only the requester's own runners (self:<id>) as a personal queue (other members' are hidden). label = hostname.
    myRunners: async (subject) => (await runnerService.list(subject)).map((r) => ({ id: r.id, label: r.label })),
    // A batch's progress total = number of dataset cases (omitted if resolution fails — progress then relies only on the child-run count).
    caseCountFor: async (tenant, id, version) => (await datasetRegistry.get(tenant, id, version)).cases.length,
    // Scheduler observability — lane admission (in-flight/memory envelope/circuit) + the workspace scheduler slice.
    schedulerStats: () => scheduler.stats(),
    circuitStats: () => breaker.stats(),
    // The scheduler's OWN wait queue + per-entry controls (cancel / move-to-front) — the service filters by
    // tenant, so another workspace's entries never leave the control plane.
    schedulerQueue: () => scheduler.queueEntries(),
    cancelSchedulerEntry: (id: string) => scheduler.cancelEntry(id),
    promoteSchedulerEntry: (id: string) => scheduler.promoteEntry(id),
    ...(tenantQuotas ? { tenantQuotaFor: (t: string) => tenantQuotas.get(t) } : {}),
    runtimeEnvelopeFor: async (tenant, id) => {
      const spec = await runtimeRegistry.get(tenant, id).catch(() => undefined);
      if (!spec) return undefined;
      return {
        ...(spec.maxConcurrent !== undefined ? { maxConcurrent: spec.maxConcurrent } : {}),
        ...(spec.memoryBudgetMb !== undefined ? { memoryBudgetMb: spec.memoryBudgetMb } : {}),
        ...(spec.cpuBudget !== undefined ? { cpuBudget: spec.cpuBudget } : {}),
      };
    },
  });
}

// Subscription registry (event-plumbing.md E3 §6) — event → reaction rules under governance. Reaction
// targets naming an agent are validated against the tenant registry, so a rule never points at nothing
// (get resolves "latest" incl. the _shared fallback — existence, not activatability).
export function buildSubscription(deps: {
  subscriptionStore: SubscriptionStore;
  agentRegistry: AgentRegistry;
}): SubscriptionService {
  // The trigger-relocation seam: read tenant-OWNED agents' latest spec triggers, and clear a spec's copy by
  // saving a new immutable version with triggers: [] (the same version-free upsert the save route uses).
  const agentSaves = new AgentService({ agents: deps.agentRegistry });
  return new SubscriptionService({
    store: deps.subscriptionStore,
    agentExists: async (tenant, agentId) => {
      try {
        await deps.agentRegistry.get(tenant, agentId, "latest");
        return true;
      } catch {
        return false;
      }
    },
    agentTriggerSource: {
      list: async (tenant) => {
        const entries = (await deps.agentRegistry.list(tenant)).filter((entry) => entry.owner === tenant);
        const out: Array<{ id: string; triggers: AgentSpec["triggers"] }> = [];
        for (const entry of entries) {
          const spec = await deps.agentRegistry.get(tenant, entry.id, "latest").catch(() => undefined);
          if (spec) out.push({ id: entry.id, triggers: spec.triggers });
        }
        return out;
      },
      clearTriggers: async (tenant, agentId) => {
        const spec = await deps.agentRegistry.get(tenant, agentId, "latest");
        if (spec.triggers.length === 0) return;
        const { id: _id, version: _version, ...rest } = spec;
        await agentSaves.saveAgent(tenant, undefined, agentId, { ...rest, triggers: [] });
      },
    },
  });
}

// Handoff checkpoints (ownership protocol O6). The evidence resolvers are bound here, and deliberately only
// for the ref types everdict can actually answer for: a run and a scorecard are records we hold, a commit is
// not — everdict does not host the tenant's git remote, and refusing a checkpoint for citing one would be
// pretending to a check nobody made. `runActor` is the independence linkage: the executor assignment the
// service hands the DOMAIN's assertIndependentVerification, so a verifier checkpoint filed by the same
// actor — or from inside the same run or session — is refused by the one invariant owner.
export function buildCheckpoint(deps: {
  handoffCheckpointStore: HandoffCheckpointStore;
  // Where a spawned verifier's verdict becomes a durable, citable VerificationDecision (arch-review 10 P1) —
  // separate aggregate from the checkpoint, because a handoff transfers state and a verification is a
  // judgment. Always wired; the SERVICE keeps it optional so a deployment without a ledger says so rather
  // than pretending it filed something.
  verificationDecisionStore?: VerificationDecisionStore;
  runStore: RunStore;
  scorecardStore: ScorecardStore;
  issueStore?: IssueStore;
  workspaceFs?: WorkspaceFs;
  events?: PlatformEventEmitter;
  // The verifier RUNTIME (the protocol's third enforcement site). Absent = verification stays a human act,
  // which is the honest state for a deployment with no agent service — never a silent auto-pass.
  verifier?: VerifierRunner;
}): CheckpointService {
  return new CheckpointService({
    store: deps.handoffCheckpointStore,
    ...(deps.verifier ? { verifier: deps.verifier } : {}),
    // The tenant comparison is the resolver's own job: RunStore.get is keyed by id alone, and a checkpoint in
    // one workspace proving a "fact" with another workspace's run would be evidence its readers cannot see.
    // Every everdict-HELD record type gets a resolver (run/scorecard/issue/file) — "unverifiable" is a claim
    // reserved for what we genuinely cannot check (a tenant's git commit, a foreign platform's trace), never
    // a shortcut past our own stores.
    resolvers: {
      run: async (tenant, id) => (await deps.runStore.get(id))?.tenant === tenant,
      scorecard: async (tenant, id) => (await deps.scorecardStore.get(id))?.tenant === tenant,
      ...(deps.issueStore
        ? { issue: async (tenant: string, id: string) => (await deps.issueStore?.get(tenant, id)) !== undefined }
        : {}),
      ...(deps.workspaceFs
        ? { file: async (tenant: string, id: string) => (await deps.workspaceFs?.stat(tenant, id)) !== undefined }
        : {}),
    },
    // The independence linkage (O3): the ACTOR a referenced run executed as, with the context it ran in —
    // runId always, sessionId when the run belongs to a session group (agent turns) — so the domain's full
    // actor/run/session invariant applies, not an id-only comparison. The EXECUTOR outranks attribution:
    // createdBy is the principal the run acted AS (member:kim), origin.executor is who actually performed it
    // (agent:fixer) — resolving the actor from createdBy compared namespaces that can never collide, so the
    // very agent that produced the work passed as its independent verifier.
    runActor: async (tenant, id) => {
      const record = await deps.runStore.get(id);
      if (record?.tenant !== tenant) return undefined;
      const actorId = record.origin?.executor ?? record.createdBy;
      if (actorId === undefined) return undefined;
      return {
        id: actorId,
        runId: record.id,
        ...(record.group?.id !== undefined ? { sessionId: record.group.id } : {}),
      };
    },
    // WHICH VERSION of the evidence a verdict is about (arch-review 25 P0-3). A scorecard's id is a locator:
    // a re-score rewrites its judgments in place, so a decision citing `scorecard:sc-7` alone lets a later
    // reader see verdicts the verifier never saw. The scoring ledger's newest entry IS that version, and it
    // is the same coordinate the release fence conditions on — one vocabulary for "which judgment of this
    // row", used by both.
    // WHICH VERSION of each piece of evidence a verdict is about (arch-review 25 P0-3, generalised by 26 P1).
    // Existence is not evidence identity, and that is not a statement about scorecards: a workspace FILE is
    // the plainest case of all — `file:plans/release.md` verified today points at different bytes next
    // quarter. Each kind is pinned by the coordinate that actually moves for it, read from the same store the
    // reader will serve from, because a pin and an observation computed over different things cannot be
    // compared.
    evidencePins: async (tenant, refs) => {
      const pinned: Array<{ type: string; id: string; identity: EvidenceIdentity }> = [];
      for (const ref of refs) {
        if (ref.type === "scorecard") {
          const record = await deps.scorecardStore.get(ref.id);
          if (record?.tenant !== tenant) continue; // unresolvable → the service records it as unpinnable
          const newest = record.scoring?.[record.scoring.length - 1];
          pinned.push({
            type: ref.type,
            id: ref.id,
            // A batch scored once and never re-scored carries no revision entry. That is not a failure to
            // pin: "this row has had no scoring pass" is itself the version, and a pass appearing changes it.
            identity: {
              kind: "scorecard",
              ...(newest?.revision !== undefined ? { scoringRevision: newest.revision } : {}),
              ...(newest?.scorePlaneDigest !== undefined ? { scorePlaneDigest: newest.scorePlaneDigest } : {}),
            },
          });
          continue;
        }
        if (ref.type === "run") {
          // A run settles once and its RESULT does not — a scoring pass rewrites `result.scores` in place.
          // `updatedAt` moves on every such write; `status` is the settlement it moves within.
          const record = await deps.runStore.get(ref.id);
          if (record?.tenant !== tenant) continue;
          pinned.push({
            type: ref.type,
            id: ref.id,
            // The RESULT is the artifact a verifier reads a run for; the stamp rides along as a second signal
            // (a timestamp alone is a mutation stamp, not an identity — arch-review 27 P1).
            identity: {
              kind: "run",
              ...(record.result !== undefined ? { resultDigest: contentDigest(record.result) } : {}),
              updatedAt: record.updatedAt,
              status: record.status,
            },
          });
          continue;
        }
        if (ref.type === "file" && deps.workspaceFs) {
          // The attributed revision the workspace filesystem publishes on every write — this platform's own
          // mutation counter for exactly this question.
          const entry = await deps.workspaceFs.stat(tenant, ref.id).catch(() => undefined);
          // No revision = nothing to pin. Recorded as unpinnable rather than as an identity that would
          // compare equal to every other file.
          if (entry?.revision === undefined) continue;
          pinned.push({ type: ref.type, id: ref.id, identity: { kind: "file", revision: entry.revision } });
          continue;
        }
        if (ref.type === "issue" && deps.issueStore) {
          const record = await deps.issueStore.get(tenant, ref.id).catch(() => undefined);
          if (record === undefined) continue;
          pinned.push({
            type: ref.type,
            id: ref.id,
            // `history[]` is the durable per-record log every write appends to — the monotone counter the
            // timestamp was standing in for.
            identity: {
              kind: "issue",
              ...(Array.isArray(record.history) ? { revision: record.history.length } : {}),
              updatedAt: record.updatedAt,
            },
          });
        }
      }
      return pinned;
    },
    ...(deps.verificationDecisionStore ? { verifications: deps.verificationDecisionStore } : {}),
    ...(deps.events ? { events: deps.events } : {}),
  });
}

// Saved scorecard-analysis Views — store/share a named AnalysisConfig (opaque config) on the workspace. Live re-run, so no snapshot.
export function buildView(deps: { viewStore: ViewStore }): ViewService {
  return new ViewService({ store: deps.viewStore });
}

// View captures — the accumulating filesystem record behind the live lens. Reads the scorecard store directly
// (cross-resource data goes through the owning store, never a peer service) and writes through the SAME
// revisioned filesystem every other surface uses, so a capture is attributed like any other publish.
export function buildViewSnapshot(deps: {
  viewStore: ViewStore;
  scorecardStore: ScorecardStore;
  workspaceFs: WorkspaceFs;
}): ViewSnapshotService {
  return new ViewSnapshotService({
    views: deps.viewStore,
    scorecards: deps.scorecardStore,
    fs: deps.workspaceFs,
  });
}

export function buildBrowserProfile(deps: { browserProfileStore: BrowserProfileStore }): BrowserProfileService {
  return new BrowserProfileService({ store: deps.browserProfileStore });
}
