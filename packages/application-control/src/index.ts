// @everdict/application-control — L2b, the control-plane use-cases + ports (re-architecture P2,
// docs/architecture/rearchitecture/00-target-architecture.md). Batch driving, store/dispatch ports,
// and (incrementally) the api services move here; composition roots (apps/*) bind the adapters.
// Imports contracts + domain only. NEVER enters the agent cone (control-plane side).
export { type Dispatch, runSuite } from "./run-suite.js";

// Store ports (interfaces only) — the impls (InMemory*/Pg*) live in @everdict/db, which binds these.
export type { AgentReportRunner } from "./ports/agent-report-runner.js";
export type { AgentSessionStore } from "./ports/agent-session-store.js";
export type { AnalysisArtifactStore } from "./ports/analysis-artifact-store.js";
export type { BrowserProfileStore } from "./ports/browser-profile-store.js";
export type { SkillStore } from "./ports/skill-store.js";
export type { SkillVersionStore } from "./ports/skill-version-store.js";
export type { KnowledgeEntryStore } from "./ports/knowledge-entry-store.js";
export type { CapabilityStore } from "./ports/capability-store.js";
export type { AgentMemberPreferenceStore } from "./ports/agent-member-preference-store.js";
export type { CallbackStore } from "./ports/callback-store.js";
export type { CommentResourceCount, CommentStore, CommentUpdatePatch } from "./ports/comment-store.js";
export type { DiscussionTurnRunner } from "./ports/discussion-turn-runner.js";
export type { NotificationListOptions, NotificationStore } from "./ports/notification-store.js";
export type { AgentEventSink } from "./ports/agent-event-sink.js";
export type { PlatformEventListOptions, PlatformEventStore } from "./ports/platform-event-store.js";
export type { EmitPlatformEventInput, PlatformEventEmitter } from "./ports/platform-event-emitter.js";
export type { ApprovalListFilter, ApprovalStore } from "./ports/approval-store.js";
export { ApprovalService, type ApprovalServiceDeps } from "./approval/approval-service.js";
export type { EnvelopeSpend, EnvelopeStore } from "./ports/envelope-store.js";
export { admitCausedWork } from "./admission/admission.js";
export type { EventConsumerStateStore } from "./ports/event-consumer-store.js";
export {
  defaultEmitter,
  EXECUTION_EMITTERS,
  executionSegment,
  INFRA_EMITTER,
  placementSpan,
  sealBody,
  sealExecutionPlanes,
  type SealedTrajectory,
  type SealInput,
  type TrajectoryBodyFormat,
  type TrajectoryListResult,
  type TrajectoryMeta,
  trajectoryReadableBy,
  type TrajectorySegment,
  trajectorySegmentsWire,
  type TrajectorySegmentWire,
  type TrajectoryStore,
} from "./ports/trajectory-store.js";
export {
  EventConsumerRunner,
  type PlatformEventConsumer,
} from "./platform-event/event-consumer-runner.js";
export { runFeedConsumer, scorecardFeedConsumer } from "./notification/feed-consumers.js";
export {
  assertPublicTarget,
  isPrivateAddress,
  refuseUnsafeCallback,
  type RunWebhookDeps,
  runWebhookConsumer,
} from "./platform-event/run-webhook-consumer.js";
export { mattermostConsumer } from "./notification/mattermost-consumer.js";
export {
  trackerUpdateConsumer,
  type TrackerUpdateConsumerDeps,
} from "./notification/tracker-update-consumer.js";
export {
  signSubscriptionPayload,
  type SubscriptionReactionDeps,
  subscriptionReactionConsumer,
} from "./platform-event/subscription-reaction-consumer.js";
export type { AdmissionLedger } from "./ports/admission-ledger.js";
export { type ReplicaRegistry, soloReplicas } from "./ports/replica-registry.js";
export type { BudgetStore } from "./ports/budget-store.js";
export type {
  LiveSessionQuery,
  LiveSessionRow,
  OutboxEvent,
  RunCreateGuard,
  RunListOptions,
  RunScoringFence,
  RunUpdateGuard,
  RunStore,
} from "./ports/run-store.js";
export type { RecordingSeal, RecordingStore } from "./ports/recording-store.js";
export { recordingGenerationOf, recordingRefOf } from "./ports/recording-store.js";
export { type CaseReceiptStore, type CaseSettleOutcome, InMemoryCaseReceiptStore } from "./ports/case-receipt-store.js";
export type { ScheduleStore } from "./ports/schedule-store.js";
export type { ScorecardListFilter, ScorecardStore, ScorecardUpdateGuard } from "./ports/scorecard-store.js";
export {
  claimSupersedes,
  INITIAL_CLAIM,
  type JudgmentClaim,
  type ScoringStageStore,
  type StagedJudgment,
} from "./ports/scoring-stage-store.js";
export type { SubscriptionStore } from "./ports/subscription-store.js";
export type { UsageStore } from "./ports/usage-store.js";
export type { AgentTaskStore } from "./ports/agent-task-store.js";
export type { CycleListFilter, CycleStore } from "./ports/cycle-store.js";
export type { WorkflowStateStore } from "./ports/workflow-state-store.js";
export {
  type CreateWorkflowStateInput,
  WorkflowStateService,
  type WorkflowStateServiceDeps,
} from "./team/workflow-state-service.js";
export {
  type CreateCycleInput,
  CYCLE_CADENCE_ACTOR,
  type CycleActor,
  type CycleDetail,
  CycleService,
  type CycleServiceDeps,
} from "./cycle/cycle-service.js";
export type { IssueListFilter, IssuePageFilter, IssueStore, IssueTeamCounts } from "./ports/issue-store.js";
export {
  type CreateIssueLabelInput,
  type IssueLabelActor,
  IssueLabelService,
  type IssueLabelServiceDeps,
} from "./issue/issue-label-service.js";
export type { IssueLabelStore } from "./ports/issue-label-store.js";
export type { IssueNumberGrant, TeamListFilter, TeamStore } from "./ports/team-store.js";
export type { ProjectListFilter, ProjectStore, ProjectUpdateStore } from "./ports/project-store.js";
export type { InitiativeListFilter, InitiativeStore, InitiativeUpdateStore } from "./ports/initiative-store.js";
export type {
  CapabilityGenerationStore,
  ProductListFilter,
  ProductStore,
  ProductVersionListFilter,
  ProductVersionStore,
  ReleaseListFilter,
  ReleaseStore,
  ReleaseDecisionContext,
} from "./ports/product-store.js";
export { ABORTABLE_SETTLE_STATUSES } from "./ports/scorecard-store.js";
export { settleRun, settleScorecard } from "./ports/settle.js";
export type { SettleOptions } from "./ports/scorecard-store.js";
export type {
  ConstitutionApproval,
  ConstitutionApprovalMode,
  ConstitutionApprovalStore,
  ConstitutionalPublisher,
} from "./ports/constitution-approval-store.js";
export { stagePromotionReport } from "./scorecard/stage-promotion-report.js";
export type { ViewStore } from "./ports/view-store.js";
export type { HandoffCheckpointStore } from "./ports/handoff-checkpoint-store.js";
export type { VerificationDecisionStore } from "./ports/verification-decision-store.js";
export type { VerifierRunner, VerifierVerdict } from "./ports/verifier-runner.js";
export {
  CheckpointService,
  type CheckpointRefResolvers,
  type CheckpointServiceDeps,
  type CreateCheckpointInput,
} from "./ownership/checkpoint-service.js";
export type { OAuthStateStore } from "./ports/oauth-state-store.js";
export type { RunnerStore } from "./ports/runner-store.js";
export type { SecretStore } from "./ports/secret-store.js";
export type { OfflineTokenMinter } from "./ports/offline-token-minter.js";
export type { TenantKeyStore } from "./ports/tenant-key-store.js";
export type { UserProfileStore } from "./ports/user-profile-store.js";
export type { FsFile, FsWriteOptions, WorkspaceFs } from "./ports/workspace-fs.js";
export type { FsRevisionStore } from "./ports/fs-revision-store.js";
export type { WorkspaceInviteStore } from "./ports/workspace-invite-store.js";
export type { WorkspaceSettingsStore } from "./ports/workspace-settings-store.js";
export type { WorkspaceStore } from "./ports/workspace-store.js";
export type { DispatchOptions, Dispatcher } from "./ports/dispatcher.js";

// Versioned-registry ports (interfaces only) — the impls (InMemory*/Pg*) + loaders live in @everdict/registry, which binds these.
export type { HarnessTemplateRegistry, HarnessTemplateListEntry } from "./ports/harness-template-registry.js";
export type { HarnessInstanceRegistry, HarnessListEntry, VersionMeta } from "./ports/harness-instance-registry.js";
export type { DatasetListEntry, DatasetRegistry } from "./ports/dataset-registry.js";
export type { JudgeListEntry, JudgeRegistry } from "./ports/judge-registry.js";
export type { RubricListEntry, RubricRegistry } from "./ports/rubric-registry.js";
export type { ModelRegistry } from "./ports/model-registry.js";
export type { AgentRegistry } from "./ports/agent-registry.js";
export type { RuntimeListEntry, RuntimeRegistry } from "./ports/runtime-registry.js";

// Control-plane use-case services (the api services move here incrementally — re-architecture P2d).
export {
  type CreateSubscriptionInput,
  SubscriptionService,
  type SubscriptionServiceDeps,
  type UpdateSubscriptionInput,
} from "./subscription/subscription-service.js";
export {
  type CreateTaskInput,
  type TaskAgentAttribution,
  TaskService,
  type TaskServiceDeps,
  type UpdateTaskInput,
} from "./task/task-service.js";
// The eval tracker (docs/tracker.md) — Initiative ⊃ Project ⊃ Issue.
export {
  type CreateIssueInput,
  type IssueActor,
  type IssueAgentAttribution,
  type IssueGithubPusher,
  IssueService,
  type IssueServiceDeps,
  type IssueTeamAllocator,
  type SetIssueStatusInput,
} from "./issue/issue-service.js";
// A capability born from an issue links itself back to it — one act, both directions (composition-root decorator).
export { type IssueBacklinkPort, withOriginBacklink } from "./issue/origin-backlink.js";
export {
  type CreateTeamInput,
  DEFAULT_TEAM_KEY,
  DEFAULT_TEAM_NAME,
  type TeamActor,
  TeamService,
  type TeamServiceDeps,
} from "./team/team-service.js";
export { REGRESSION_WATCH_ACTOR, regressionWatch, type RegressionWatchDeps } from "./issue/regression-watch.js";
export {
  GithubIssueSync,
  type GithubIssueSyncDeps,
  type GithubRepositoryTokenSource,
  type ImportGithubIssuesInput,
  type ImportGithubIssuesResult,
  type SyncOutcome,
} from "./issue/github-issue-sync.js";
export {
  type CreateProjectInput,
  type ProjectActor,
  type ProjectDefaultTeamResolver,
  ProjectService,
  type ProjectServiceDeps,
} from "./project/project-service.js";
export {
  type CreateInitiativeInput,
  type InitiativeActor,
  InitiativeService,
  type InitiativeServiceDeps,
} from "./initiative/initiative-service.js";
export {
  type CreateProductInput,
  type CreateReleaseInput,
  type ProductActor,
  type ProductCapabilityCheck,
  ProductService,
  type ProductServiceDeps,
} from "./product/product-service.js";
export {
  ProductVersionSync,
  type ProductVersionSyncDeps,
  type ProductSyncResult,
  type ProductSyncServiceOutcome,
} from "./product/product-version-sync.js";
export {
  SeriesEvaluator,
  type SeriesEvaluatorDeps,
  type SeriesRunInput,
  type SeriesRunOutcome,
  type SeriesRunSubmitter,
  type SeriesRunTrigger,
} from "./product/series-evaluator.js";
export { ProductDiscovery, type ProductDiscoveryDeps } from "./product/product-discovery.js";
export { type SeriesContractDeps, resolveSeriesContract } from "./product/series-contract.js";
export { type CreateViewInput, type UpdateViewInput, ViewService, type ViewServiceDeps } from "./view/view-service.js";
export {
  type CaptureViewSnapshotInput,
  ViewSnapshotService,
  type ViewSnapshotRef,
  type ViewSnapshotServiceDeps,
} from "./view/view-snapshot-service.js";
export {
  BrowserProfileService,
  type BrowserProfileServiceDeps,
  type CreateBrowserProfileInput,
  type UpdateBrowserProfileInput,
} from "./browser-profile/browser-profile-service.js";
export { FileExecutionService } from "./fs/file-execution-service.js";
export { type FsFileContent, FsService, type WriteFsFileInput } from "./fs/fs-service.js";
export { memberActor, RevisionedWorkspaceFs } from "./fs/revisioned-workspace-fs.js";
export {
  type CreateSkillInput,
  type ImportSkillInput,
  SkillService,
  type SkillActor,
  type SkillServiceDeps,
  type SkillWithCoverage,
  type StampSkillVersionInput,
  type StoreCapabilityReader,
  type UpdateSkillInput,
} from "./skill/skill-service.js";
export {
  type CapabilityActor,
  CapabilityService,
  type CapabilityServiceDeps,
  type CapabilityUpsert,
  type CapabilityVersions,
  type SaveCapabilityResult,
} from "./capability/capability-service.js";
export {
  type CapabilityMoved,
  type MoveCapabilityInput,
  moveCapabilityToTeam,
  TEAM_TRANSFERABLE_CAPABILITIES,
  type TeamTransferableRegistry,
  type TransferableCapability,
} from "./capability/move-capability-team.js";
export {
  type FirstPartyDefault,
  firstPartyCatalogExtras,
  firstPartyDefaults,
  firstPartyDelegationExamples,
  firstPartySkillExamples,
  WEBSEARCH_SECRET_NAME,
} from "./capability/first-party.js";
export { ProxyService, type ProxyServiceDeps, type ProxyView } from "./proxy/proxy-service.js";
export {
  COMMENT_AGENT_AUTHOR,
  COMMENT_RESOURCE_TYPES,
  type CommentAgentAttribution,
  type CommentResourceType,
  CommentService,
  type CommentServiceDeps,
} from "./comment/comment-service.js";
export {
  attestDatasetConstitution,
  deleteDatasetVersion,
  deleteDatasetVersions,
} from "./dataset/dataset-service.js";
export { deleteModelVersion, deleteModelVersions } from "./model/model-service.js";
export { deleteAgentVersion, deleteAgentVersions } from "./agent/agent-service.js";
// The per-member agent — the single answer the settings pages render and the agent runtime carries (tools + skills).
export {
  type AgentCapabilitiesDeps,
  type AgentCapabilitiesQuery,
  type AgentCapabilitiesResolution,
  type AgentSkillOrigin,
  type AgentToolOrigin,
  type ResolvedAgentSkill,
  type ResolvedAgentTool,
  resolveAgentCapabilities,
} from "./agent/agent-capabilities.js";
export { deleteHarnessVersion, harnessIsPrivate, harnessVisibleTo } from "./harness/harness-service.js";
export { deleteJudgeVersion } from "./judge/judge-service.js";
export {
  type PairRunnerBody,
  PairRunnerBodySchema,
  RUNNER_CAPABILITIES,
  RunnerService,
  runnerUpdateRequired,
} from "./runner/runner-service.js";
export { generateAgentToken, generateInviteToken, generateKey, hashKey } from "./credential/credentials.js";
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
  adoptedImageReach,
  type AdoptedImageReachDeps,
} from "./environment-adoption/adopted-image-reach.js";
export {
  type AdoptedEnvironmentVerify,
  type AdoptedEnvironmentView,
  EnvironmentAdoptionService,
  type EnvironmentAdoptionServiceDeps,
  type EnvironmentRef,
} from "./environment-adoption/environment-adoption-service.js";
export {
  type ImagePushCredentials,
  ImageRegistryService,
  type ImageRegistryServiceDeps,
  type ImageRegistryView,
} from "./image-registry/image-registry-service.js";
export type { ImageManifestInfo, RegistryConnectivity, RegistryReader } from "./ports/registry-reader.js";
export type { WorkspaceImages } from "./ports/workspace-images.js";
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
  type AttemptAuthority,
  type AttemptToken,
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
export type {
  MattermostChannel,
  MattermostClient,
  MattermostPost,
  MattermostPostView,
  MattermostProbeResult,
} from "./ports/mattermost-client.js";
export { NotificationService, type NotificationServiceDeps } from "./notification/notification-service.js";
export { PlatformEventService, type PlatformEventServiceDeps } from "./platform-event/platform-event-service.js";
export { withRegisteredFact } from "./platform-event/registry-facts.js";
// Facts → outbox rows. Exported because a control-plane service OUTSIDE this package (the browser lane) also
// writes run transitions, and every such writer must stamp them the same way — see .claude/rules/events.md.
export { stampFacts, type StampedFact } from "./platform-event/outbox.js";
export { withTracePerception } from "./observability/trace-perception.js";
export {
  SandboxSessionService,
  type CreateSandboxInput,
  type ResolvedDelegationProfile,
  type ResolvedSessionHarness,
  type SandboxActor,
  type SandboxSessionServiceDeps,
  type SandboxSessionView,
  type SandboxTaskSummary,
  type SandboxTaskTrace,
} from "./session/sandbox-session-service.js";
export type {
  ConversationTurnOutcome,
  ResolvedServiceConversation,
  ServiceConversation,
} from "./ports/service-conversation.js";
export { scopedComputeHandle } from "./session/scoped-compute.js";
export { FIRST_PARTY_AGENT_TEMPLATES, seedFirstPartyAgents } from "./agent/first-party-agents.js";
export type {
  GithubAsset,
  GithubFileContent,
  GithubIssue,
  GithubIssueComment,
  GithubRelease,
  GithubRepoTreeReader,
  GithubRepoTreeReaderFactory,
  GithubRepoWriter,
  GithubRepoWriterFactory,
  GithubTag,
  GithubVersionReader,
  GithubVersionReaderFactory,
} from "./ports/github-repo-writer.js";
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
export { type ArtifactStore, DOM_INLINE_MAX, offloadSnapshot, refreshSnapshotRefs } from "./ports/artifact-store.js";

// Control-plane execution machinery (re-architecture P2 S3) — the pure execution unit, out-of-job trace
// collection, and trace-based scoring. defaultJudgeRunner (the graders-transport adapter) stays in apps/api
// behind the JudgeRunner port (it composes @everdict/graders values the application layer must not import).
export type { JudgeRunner, NestedDocumentPins } from "./ports/judge-runner.js";
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
export { type LeaderElector, soleLeader, whenLeader } from "./ops/leadership.js";
export { tombstoneInterrupted } from "./ops/tombstone.js";
export {
  type DriverAuthority,
  INTERRUPTED,
  type RecoveryDeps,
  recoverInterrupted,
} from "./ops/startup-recovery.js";
export { settleOrphanSessionRuns } from "./ops/session-run-sweep.js";
export { Metrics } from "./ops/metrics.js";
export { assertRuntimeTarget } from "./require-runtime/require-runtime.js";

// Run / schedule / queue orchestration services (re-architecture P2 S5) — the standalone-run lifecycle, the
// cron-schedule lifecycle (Temporal driver stays in apps/api), and the work-queue snapshot.
export {
  type LiveTraceRef,
  type RunFsEntry,
  type RunFsFile,
  type RunFsStatus,
  type RunFsTree,
  type ResumeResult,
  RunService,
  type RunServiceDeps,
  type SubmitInput,
} from "./run/run-service.js";
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
  type QueueSchedulerEntry,
  QueueService,
  type QueueServiceDeps,
  type QueueSnapshot,
  type QueueUpcoming,
  type SchedulerQueueEntryView,
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
  originSource,
} from "./scorecard/scorecard-requests.js";
export {
  type AnalysisBundle,
  analysisBundle,
  exportStepMessage,
  analysisRevisionKey,
  offloadAnalysis,
  offloadResults,
} from "./scorecard/scorecard-observability.js";
export type { ScorecardServiceDeps } from "./scorecard/scorecard-deps.js";
export { applyGradingPlan, caseReason, childKey, selectSubsetCases } from "@everdict/domain";
export { ScorecardService } from "./scorecard/scorecard-service.js";
export { ScorecardBatchService } from "./scorecard/scorecard-batch-service.js";
export { ScorecardIngestService } from "./scorecard/scorecard-ingest-service.js";
export { ScorecardAnalyticsService } from "./scorecard/scorecard-analytics-service.js";
export { dispatchManifest, foldEnvDeltas } from "./recording-manifest.js";

// knowledge — the knowledge-graph store port + the harvest ingest use-case (projection lives in @everdict/domain).
export type { KnowledgeStore } from "./ports/knowledge-store.js";
export { ingestHarvest } from "./knowledge/ingest-harvest.js";
export {
  KnowledgeQueryService,
  type NeighborQuery,
  type RelatedFact,
  type Subgraph,
  type TraversalDirection,
} from "./knowledge/knowledge-query-service.js";
export {
  type KnowledgeContextSources,
  type KnowledgeGraphResult,
  KnowledgeService,
  type KnowledgeReindexResult,
  type KnowledgeReindexSources,
  type KnowledgeServiceDeps,
  type TaskContext,
  type TaskContextAnchor,
  type TaskContextSkill,
} from "./knowledge/knowledge-service.js";
export {
  type LatestVersionResolver,
  registryLatestVersionResolver,
  resolveCoverage,
  type VersionedRegistries,
} from "./knowledge/freshness-resolver.js";
export {
  type CreateKnowledgeEntryInput,
  type KnowledgeEntryActor,
  KNOWLEDGE_EXTRACTION_AUTHOR,
  KnowledgeEntryService,
  type ProposeKnowledgeEntryInput,
  type KnowledgeEntryServiceDeps,
  type KnowledgeEntryWithCoverage,
  type UpdateKnowledgeEntryInput,
} from "./knowledge/knowledge-entry-service.js";
