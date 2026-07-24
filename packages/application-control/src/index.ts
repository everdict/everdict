// @everdict/application-control — L2b, the control-plane use-cases + ports (re-architecture P2,
// docs/architecture/rearchitecture/00-target-architecture.md). Batch driving, store/dispatch ports,
// and (incrementally) the api services move here; composition roots (apps/*) bind the adapters.
// Imports contracts + domain only. NEVER enters the agent cone (control-plane side).
export { type Dispatch, runSuite } from "./run-suite.js";

// Store ports (interfaces only) — the impls (InMemory*/Pg*) live in @everdict/db, which binds these.
export type { AgentSessionStore } from "./ports/agent-session-store.js";
export type { BrowserProfileStore } from "./ports/browser-profile-store.js";
export type { SkillStore } from "./ports/skill-store.js";
export type { CallbackStore } from "./ports/callback-store.js";
export type { CommentStore } from "./ports/comment-store.js";
export type { NotificationListOptions, NotificationStore } from "./ports/notification-store.js";
export type { BudgetStore } from "./ports/budget-store.js";
export type { RunListOptions, RunStore } from "./ports/run-store.js";
export type { RecordingSeal, RecordingStore } from "./ports/recording-store.js";
export type { ScheduleStore } from "./ports/schedule-store.js";
export type { ScorecardListFilter, ScorecardStore } from "./ports/scorecard-store.js";
export type { UsageStore } from "./ports/usage-store.js";
export type { ViewStore } from "./ports/view-store.js";
export type { OAuthStateStore } from "./ports/oauth-state-store.js";
export type { RunnerStore } from "./ports/runner-store.js";
export type { SecretStore } from "./ports/secret-store.js";
export type { OfflineTokenMinter } from "./ports/offline-token-minter.js";
export type { TenantKeyStore } from "./ports/tenant-key-store.js";
export type { UserProfileStore } from "./ports/user-profile-store.js";
export type { WorkspaceInviteStore } from "./ports/workspace-invite-store.js";
export type { WorkspaceSettingsStore } from "./ports/workspace-settings-store.js";
export type { WorkspaceStore } from "./ports/workspace-store.js";
export type { DispatchOptions, Dispatcher } from "./ports/dispatcher.js";

// Versioned-registry ports (interfaces only) — the impls (InMemory*/Pg*) + loaders live in @everdict/registry, which binds these.
export type { HarnessTemplateRegistry } from "./ports/harness-template-registry.js";
export type { HarnessInstanceRegistry, HarnessListEntry, VersionMeta } from "./ports/harness-instance-registry.js";
export type { DatasetListEntry, DatasetRegistry } from "./ports/dataset-registry.js";
export type { JudgeListEntry, JudgeRegistry } from "./ports/judge-registry.js";
export type { RubricListEntry, RubricRegistry } from "./ports/rubric-registry.js";
export type { ModelRegistry } from "./ports/model-registry.js";
export type { AgentRegistry } from "./ports/agent-registry.js";
export type { RuntimeListEntry, RuntimeRegistry } from "./ports/runtime-registry.js";

// Control-plane use-case services (the api services move here incrementally — re-architecture P2d).
export { type CreateViewInput, type UpdateViewInput, ViewService, type ViewServiceDeps } from "./view/view-service.js";
export {
  BrowserProfileService,
  type BrowserProfileServiceDeps,
  type CreateBrowserProfileInput,
  type UpdateBrowserProfileInput,
} from "./browser-profile/browser-profile-service.js";
export {
  type CreateSkillInput,
  SkillService,
  type SkillActor,
  type SkillServiceDeps,
  type UpdateSkillInput,
} from "./skill/skill-service.js";
export { ProxyService, type ProxyServiceDeps, type ProxyView } from "./proxy/proxy-service.js";
export {
  COMMENT_RESOURCE_TYPES,
  type CommentResourceType,
  CommentService,
  type CommentServiceDeps,
} from "./comment/comment-service.js";
export { deleteDatasetVersion, deleteDatasetVersions } from "./dataset/dataset-service.js";
export { deleteModelVersion, deleteModelVersions } from "./model/model-service.js";
export { deleteAgentVersion, deleteAgentVersions } from "./agent/agent-service.js";
export { deleteHarnessVersion, harnessIsPrivate, harnessVisibleTo } from "./harness/harness-service.js";
export { deleteJudgeVersion } from "./judge/judge-service.js";
export {
  type PairRunnerBody,
  PairRunnerBodySchema,
  RUNNER_CAPABILITIES,
  RunnerService,
  runnerUpdateRequired,
} from "./runner/runner-service.js";
export { generateInviteToken, generateKey, hashKey } from "./credential/credentials.js";
export { WorkspaceService } from "./workspace/workspace-service.js";
export { ProfileService } from "./profile/profile-service.js";
export { MembershipService } from "./member/membership-service.js";
export {
  type RepinBody,
  RepinBodySchema,
  type RepinResult,
  repinHarnessImages,
} from "./harness/harness-pin-service.js";
export {
  type ImagePushCredentials,
  ImageRegistryService,
  type ImageRegistryServiceDeps,
  type ImageRegistryView,
} from "./image-registry/image-registry-service.js";
export {
  type MattermostConfigView,
  MattermostService,
  type MattermostServiceConfig,
  type MattermostServiceDeps,
  type MattermostStatus,
} from "./mattermost/mattermost-service.js";
export {
  MattermostCommandService,
  type MattermostCommandServiceDeps,
  type MattermostReply,
} from "./mattermost/mattermost-command-service.js";
export {
  type EnqueueResult,
  type LeasedJob,
  POOL_RUNNER,
  poolKeyFor,
  requiredRunnerCapabilities,
  RunnerHub,
  type RunnerHubDeps,
  selfHostedBackendName,
  type SelfHostedKey,
} from "./runner/runner-hub.js";
export { type RunnerHubLike, StoreRunnerHub, type StoreRunnerHubDeps } from "./runner/store-runner-hub.js";
export type {
  ClaimInput,
  ParkInput,
  RunnerJobLease,
  RunnerJobOutcome,
  RunnerJobStore,
} from "./ports/runner-job-store.js";
export {
  normalizeVersionTags,
  setVersionTags,
  type VersionTaggable,
  VersionTagsBodySchema,
} from "./version-tag/version-tag-service.js";
export type { MattermostClient, MattermostPost, MattermostProbeResult } from "./ports/mattermost-client.js";
export { NotificationService, type NotificationServiceDeps } from "./notification/notification-service.js";
export type { GithubRepoWriter, GithubRepoWriterFactory } from "./ports/github-repo-writer.js";
export {
  CiLinkService,
  type CiLinkServiceDeps,
  type GithubAppRepoAccess,
  renderCiWorkflow,
  type RepoInfo,
  type UpsertCiLinkBody,
  UpsertCiLinkBodySchema,
  type WorkspaceRunnerRoster,
} from "./ci-link/ci-link-service.js";
export {
  type GithubRunnerInstallInput,
  type GithubRunnerInstallResult,
  installGithubWorkspaceRunner,
} from "./runner/github-runner-install.js";
export { renderRunnerAttachCommand } from "./runner/runner-attach-command.js";
export {
  isRunnerToken,
  renderRunnerInstallCommand,
  renderRunnerInstallScript,
} from "./runner/runner-install.js";
export type {
  GithubAppCreds,
  GithubAppGateway,
  GithubInstallationRepo,
} from "./ports/github-app-gateway.js";
export {
  type GithubAppDetailView,
  type GithubAppProviders,
  GithubAppService,
  type GithubAppServiceConfig,
  type GithubAppServiceDeps,
  type GithubAppView,
  type GithubComAppConfig,
  type GithubEnterpriseAppConfig,
  type InstallationRepo,
  type InstallationWithRepos,
  type StartInstallInput,
} from "./github-app/github-app-service.js";
export { createLimiter, type Limiter } from "./concurrency/limiter.js";
export {
  type CaseExportStream,
  TraceSinkService,
  type TraceSinkServiceDeps,
} from "./trace-sink/trace-sink-service.js";
export {
  type TraceSourceConfigView,
  TraceSourceService,
  type TraceSourceServiceDeps,
  unifiedTraceSources,
} from "./trace-source/trace-source-service.js";
export { resolveHarnessTraceMapping } from "./trace-source/resolve-harness-mapping.js";
export { SpanAttrMappingService } from "./trace-source/span-attr-mapping-service.js";
export { type ArtifactStore, offloadSnapshot } from "./ports/artifact-store.js";

// Control-plane execution machinery (re-architecture P2 S3) — the pure execution unit, out-of-job trace
// collection, and trace-based scoring. defaultJudgeRunner (the graders-transport adapter) stays in apps/api
// behind the JudgeRunner port (it composes @everdict/graders values the application layer must not import).
export type { JudgeRunner } from "./ports/judge-runner.js";
export { type ExecuteCaseDeps, executeCase, jobImages } from "./execution/execute-case.js";
export { type CollectTraceDeps, collectDeferredTrace } from "./execution/collect-trace.js";
export { type JudgeStream, ScoringService, type ScoringServiceDeps } from "./execution/scoring-service.js";

// Batch-orchestration ops machinery (re-architecture P2 S4) — adaptive concurrency, OOM auto-boost, runtime
// spillover + tail speculation, history-informed shard weights, the scheduling knobs, boot recovery, and the
// Prometheus metrics registry. runtime-probe stays in apps/api (it composes @everdict/backends placement
// builders, which are infrastructure the application layer must not import).
export { type AdaptiveConcurrencyOpts, AdaptiveConcurrencyGate } from "./ops/adaptive-concurrency.js";
export { OOM_ESCALATION_CAP_MB, type OomBoostOpts, executeWithOomBoost } from "./ops/oom-boost.js";
export { type SpilloverOpts, type SpilloverOutcome, executeWithSpillover } from "./ops/runtime-spillover.js";
export { type SpeculationOpts, SpeculationController } from "./ops/speculation.js";
export { weightedTargets } from "./ops/shard-weights.js";
export {
  type AutoscaleConfig,
  parseAutoscale,
  parseTenantMap,
  type TenantValueMap,
} from "./ops/scheduling-config.js";
export { type RecoveryDeps, recoverInterrupted } from "./ops/startup-recovery.js";
export { Metrics } from "./ops/metrics.js";
export { assertRuntimeTarget } from "./require-runtime/require-runtime.js";

// Run / schedule / queue orchestration services (re-architecture P2 S5) — the standalone-run lifecycle, the
// cron-schedule lifecycle (Temporal driver stays in apps/api), and the work-queue snapshot.
export { type LiveTraceRef, RunService, type RunServiceDeps, type SubmitInput } from "./run/run-service.js";
export {
  type CreateScheduleInput,
  type ScheduleDriver,
  type ScheduleRecordWithNext,
  ScheduleService,
  type ScheduleServiceDeps,
  type ScheduleSpec,
  type UpdateScheduleInput,
  isValidCron,
} from "./schedule/schedule-service.js";
export {
  type QueueItem,
  type QueueLane,
  type QueueLaneAdmission,
  QueueService,
  type QueueServiceDeps,
  type QueueSnapshot,
  type QueueUpcoming,
} from "./queue/queue-service.js";

// Scorecard cluster (re-architecture P2 S4) — the batch-eval facade over its lifecycle collaborators (batch
// orchestration / ingest / analytics) + the shared plumbing (deps interface, ingest/pull body schemas, subset
// and grading-plan helpers). The Temporal batch driver stays in apps/api (a Temporal adapter, infrastructure).
export {
  IngestScorecardBodySchema,
  PullIngestBodySchema,
  type IngestScorecardBody,
  type IngestScorecardInput,
  type PullIngestBody,
  type PullIngestInput,
  type RunScorecardInput,
  type ScorecardServiceDeps,
  applyGradingPlan,
  caseReason,
  childKey,
  exportStepMessage,
  offloadResults,
  originSource,
  selectSubsetCases,
} from "./scorecard/scorecard-shared.js";
export { ScorecardService } from "./scorecard/scorecard-service.js";
export { ScorecardBatchService } from "./scorecard/scorecard-batch-service.js";
export { ScorecardIngestService } from "./scorecard/scorecard-ingest-service.js";
export { ScorecardAnalyticsService } from "./scorecard/scorecard-analytics-service.js";
export { dispatchManifest, foldEnvDeltas } from "./recording-manifest.js";
