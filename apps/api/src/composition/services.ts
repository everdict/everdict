import { CiLinkService } from "@everdict/application-control";
import type { GithubAppService } from "@everdict/application-control";
import { MattermostCommandService } from "@everdict/application-control";
import type { TenantValueMap } from "@everdict/application-control";
import { QueueService } from "@everdict/application-control";
import type { RunnerService } from "@everdict/application-control";
import type { ScheduleService } from "@everdict/application-control";
import type { ScorecardService } from "@everdict/application-control";
import { ViewService } from "@everdict/application-control";
import type { Scheduler } from "@everdict/backends";
import type { RunStore, ScorecardStore, SecretStore, ViewStore, WorkspaceSettingsStore } from "@everdict/db";
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
      const lb = await scorecardService.leaderboard(workspace, { datasetId, metric: "tests_pass" });
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
    benchmarks: benchmarkService,
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

// Saved scorecard-analysis Views — store/share a named AnalysisConfig (opaque config) on the workspace. Live re-run, so no snapshot.
export function buildView(deps: { viewStore: ViewStore }): ViewService {
  return new ViewService({ store: deps.viewStore });
}
