// @everdict/domain — THE unique domain layer (L1). Every business rule has exactly one
// implementation here (re-architecture P1, docs/architecture/rearchitecture/00-target-architecture.md).
// Pure by construction: imports @everdict/contracts only — no I/O, no stores, no SDKs.
// Grouped by domain (scorecard/, run/, member/, …); the barrel re-exports every public symbol.

// scorecard — verdict authority + pass@k trials + diff/z-test + leaderboard/trend/models (from @everdict/suite)
export {
  type CaseDelta,
  caseVerdict,
  diffScorecards,
  type MetricSummary,
  type ScorecardDiff,
  scorecardPassRate,
  summarizeScorecard,
} from "./scorecard/scorecard.js";
export {
  type CaseTrialStats,
  caseTrialStats,
  diffTrials,
  groupTrials,
  passAtK,
  type ScorecardTrialSummary,
  summarizeTrials,
  type TrialCaseDelta,
  type TrialDiff,
} from "./scorecard/trials.js";
export {
  type Leaderboard,
  leaderboard,
  type LeaderboardCard,
  type LeaderboardRow,
} from "./scorecard/leaderboard.js";
export {
  type ScorecardTrend,
  type TrendCard,
  type TrendPoint,
  trendSeries,
} from "./scorecard/trend.js";
export { type ScorecardModels, scorecardModels } from "./scorecard/models.js";
export { headlinePassRate } from "./scorecard/headline.js";

// scorecard — flexible analysis pivot (filter/group/pivot/measure), the server-side twin of the web engine
export {
  ANALYSIS_DIMENSIONS,
  ANALYSIS_MEASURES,
  ANALYSIS_TIME_DIMENSIONS,
  ANALYSIS_VIZ,
  type AnalysisCard,
  type AnalysisConfig,
  type AnalysisDimension,
  type AnalysisFilters,
  type AnalysisGridResult,
  type AnalysisGridRow,
  type AnalysisLineResult,
  type AnalysisMeasure,
  type AnalysisResult,
  type AnalysisViz,
  analysisConfigFromStored,
  analysisDimensionValue,
  analysisMetricNames,
  computeAnalysis,
} from "./scorecard/analysis.js";

// scorecard — the ScorecardBatch aggregate (from apps/api core/scorecard)
export {
  type NewChildRunInput,
  type NewQueuedBatchInput,
  type NewQueuedIngestInput,
  ScorecardBatch,
  type ScorecardOrchestration,
  type ScorecardOutcomeExtras,
  type ScorecardRunError,
  type ScorecardTransition,
} from "./scorecard/scorecard-batch.js";

// run — the Run aggregate (from apps/api core/run)
export { type NewQueuedRunInput, Run, type RunTransition } from "./run/run.js";
export { Approval, type ApprovalTransition, type NewPendingApprovalInput } from "./approval/approval.js";

// member — the last-admin invariant (from apps/api core/member)
export { MembershipPolicy } from "./member/membership-policy.js";

// runner — self-hosted runner liveness (the online window the dispatch-time "no online runner" diagnostic keys on)
export { isRunnerOnline, RUNNER_ONLINE_WINDOW_MS } from "./runner/liveness.js";

// schedule — the Schedule aggregate + cron validity (from apps/api core/schedule)
export {
  isValidCron,
  type NewScheduleInput,
  Schedule,
  type ScheduleActor,
  type ScheduleSpec,
  type ScheduleTransition,
} from "./schedule/schedule.js";

// failure — the failure-classification rules (from @everdict/core; the CaseFailure shape stays in contracts)
export { classifyFailure, stageForError } from "./failure/case-failure.js";

// harness — secret-resolution/visibility rules (from @everdict/core)
export {
  flattenEnv,
  type HarnessSecretMaps,
  referencesUserSecret,
  resolveHarnessSecrets,
} from "./harness/harness-secrets.js";

// harness — resolved-spec version diff (base ↔ candidate)
export { diffHarnessSpecs } from "./harness/harness-diff.js";

// secret — reverse-usage index (which registry specs / settings integrations reference a workspace secret by name)
export { collectSecretUsages, type SecretUsage, type SecretUsageInputs } from "./secret/secret-usage.js";

// judge — spec version diff (base ↔ candidate); shares the spec-diff engine with the harness diff
export { diffJudgeSpecs } from "./judge/judge-diff.js";

// harness — cross-runtime portability lint (reject a service spec that resolves to different addresses per runtime)
export {
  type PortabilityIssue,
  type PortabilityRule,
  type PortabilityServiceSpec,
  assertPortable,
  checkPortability,
  portabilityErrors,
} from "./harness/portability.js";

// harness — Model-binding → connection env (provider-standard names + per-binding override; apiKeySecret resolution)
export {
  modelApiKeySecretName,
  modelBindingLabel,
  modelConnectionEnv,
  normalizeModelBinding,
} from "./model/model-binding.js";

// runtime — capability gating + trust-zone hardening rules (from @everdict/core)
export {
  capabilitiesOfKind,
  capabilityKind,
  functionalGate,
  partitionCapabilities,
  runtimeSatisfies,
} from "./runtime/capability.js";
export {
  defaultRuntimeCapabilities,
  requiredCapabilities,
  requiredCapabilitiesForHarness,
  requiredCapabilitiesForJob,
  requiredCapabilitiesForTopology,
  runtimeSpecWithCapabilities,
  topologyNeedsDocker,
} from "./runtime/capability-requirements.js";
export { assertHardenedIsolation, isHardenedRuntime } from "./runtime/trust-zone-hardening.js";

// image — image-reference parse/classify/warn rules (from @everdict/core; shapes stay in contracts)
export {
  classifyImageRef,
  collectHarnessImages,
  dockerAuthConfigJson,
  imageRegistryPrefix,
  imageRepoFor,
  imageUsesRegistryHost,
  imageWarnings,
  parseImageRef,
  pickRegistryAuth,
  registryAuthsForImages,
  registryAuthsOf,
} from "./image/image-ref.js";

// image — display-image (avatar/logo) validation (from apps/api common)
export { validateImageRef } from "./image/display-image.js";

// trace — trace-derived usage summary (from @everdict/core; shapes stay in contracts)
export { usageFromTrace } from "./trace/usage-from-trace.js";
export {
  trajectoryMetrics,
  trajectoryMetricValue,
  type TrajectoryMetrics,
} from "./trace/trajectory-metrics.js";
export { clampFidelity, FIDELITY_ORDER } from "./recording/fidelity.js";

// capability — the Capability Store's reach/visibility kernel (new; the four-tier private|workspace|subset|public authority)
export {
  type CapabilityAccess,
  type CapabilityConsumer,
  canConsumeCapability,
  filterConsumableCapabilities,
} from "./capability/capability-visibility.js";
// capability — the first-party default-toolset selection kernel (which built-in tools apply to a workspace)
export {
  type DefaultCapabilityInput,
  type DefaultSelectionContext,
  configuredIntegrations,
  selectDefaultCapabilities,
} from "./capability/capability-defaults.js";
// capability — the per-MEMBER selection kernel, shared by the tool and skill channels (workspace baseline ⊕ the
// member's own overrides + name shadowing)
export {
  type MemberSelection,
  type MemberSelectionCandidate,
  authoredSkillKey,
  builtinToolKey,
  capabilityToolKey,
  mcpServerToolKey,
  selectForMember,
} from "./capability/member-selection.js";
// capability — spec version diff (base ↔ candidate); shares the spec-diff engine with the harness/judge diffs
export { diffCapabilitySpecs } from "./capability/capability-diff.js";
// capability — the names a bridged tool wears in front of the model (the runtime registers them, the UI explains them)
export { codeBridgedName, mcpBridgePrefix, mcpBridgedName } from "./capability/tool-naming.js";

// registry — the version algebra every versioned registry shares (from @everdict/registry)
export {
  bumpVersion,
  compareVersions,
  LATEST,
  resolveRef,
  SHARED_TENANT,
  sortVersions,
  specsEqual,
  type VersionBump,
} from "./registry/version-algebra.js";

// placement — pure multi-tenant placement policies (from @everdict/backends)
export { FairQueue, type FairQueueOptions } from "./placement/fair-queue.js";
export { CircuitBreaker, type CircuitBreakerOpts } from "./placement/circuit-breaker.js";
export {
  aggregateLoad,
  type AutoscalePolicy,
  Autoscaler,
  type AutoscalerOptions,
  desiredCapacity,
  type LoadSignal,
  MutableSlots,
  type ScalingTarget,
} from "./placement/autoscaler.js";
export {
  type PerTenantTrustZoneOptions,
  perTenantTrustZones,
  staticTrustZones,
  type TrustZonePolicy,
} from "./placement/trust-zone.js";

// auth — the role→action matrix + the identity subject shape (from @everdict/auth)
export {
  type Action,
  API_KEY_SCOPES,
  type ApiKeyScope,
  authorize,
  can,
  EVERDICT_ROLES,
  type EverdictRole,
} from "./auth/authz.js";
export type { AuthContext, Principal } from "./auth/principal.js";

// billing — cost attribution + enforcement budget + metered usage (from @everdict/billing)
export { type BillingCharge, billingCharges, billingTenant, costOf, sumCost } from "./billing/cost.js";
export { priceUsd } from "./billing/pricing.js";
export {
  assertWithinBudget,
  type BudgetLimit,
  type BudgetTracker,
  type BudgetUsage,
  inMemoryBudget,
  type InMemoryBudgetOptions,
} from "./billing/budget.js";
export {
  inMemoryUsageMeter,
  type TenantUsage,
  totalUsage,
  USAGE_SOURCES,
  usageDay,
  type UsageDayItem,
  type UsageItem,
  type UsageMeter,
  type UsageSource,
  type UsageTotals,
} from "./billing/usage.js";

// knowledge — the knowledge-graph kernel: deterministic id derivation + structured harvesters (record → graph spine).
export { edgeId, mentionId, nodeId } from "./knowledge/ids.js";
export { type HarvestResult, HarvestBuilder } from "./knowledge/harvest.js";
export { harvestScorecard, SCORECARD_HARVESTER } from "./knowledge/harvest-scorecard.js";
export { PREDICATE_PRIORITY, predicateRank } from "./knowledge/ranking.js";
export {
  COMMENT_HARVESTER,
  harvestComment,
  harvestMembership,
  harvestRun,
  harvestSchedule,
  MEMBERSHIP_HARVESTER,
  RUN_HARVESTER,
  SCHEDULE_HARVESTER,
} from "./knowledge/harvest-records.js";
export {
  AGENT_HARVESTER,
  CAPABILITY_HARVESTER,
  DATASET_HARVESTER,
  harvestAgent,
  harvestCapability,
  harvestDataset,
  harvestHarness,
  harvestJudge,
  harvestModel,
  harvestRubric,
  harvestRuntime,
  HARNESS_HARVESTER,
  JUDGE_HARVESTER,
  MODEL_HARVESTER,
  RUBRIC_HARVESTER,
  RUNTIME_HARVESTER,
  type SpecHarvestMeta,
} from "./knowledge/harvest-specs.js";
export {
  harvestKnowledgeEntry,
  harvestSkill,
  KNOWLEDGE_ENTRY_HARVESTER,
  SKILL_HARVESTER,
} from "./knowledge/harvest-knowledge.js";
export {
  type AnchorRelation,
  anchorRelation,
  assessCoverage,
  type Coverage,
  type CoverageGap,
  type CoverageState,
  DEFAULT_UNVERIFIED_AFTER_DAYS,
  intervalEnd,
} from "./knowledge/freshness.js";

// workspace-file — three-way text merge: how two authors (member and/or agent) editing one file at the same
// time reconcile without either write silently winning. Plus the run plan: which interpreter and image a file
// gets when someone presses Run on it.
export { mergeThreeWay } from "./workspace-file/merge.js";
// …and the line diff between two revisions of one file, over the SAME line matching the merge uses.
export { diffFileText } from "./workspace-file/diff.js";
export { type FileRunPlan, fileRunPlanFor, isRunnableFilePath } from "./workspace-file/run-plan.js";

// subscription — the one event-selection predicate shared by agent triggers and E3 subscriptions (kinds
// allowlist + declarative payload filters): every reaction executor matches events through this law.
export {
  type EventSelector,
  eventSelectorMatches,
  type SelectorEvent,
} from "./subscription/selector-match.js";
