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
} from "./harness/model-binding.js";

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
} from "./runtime/capability-requirements.js";
export { assertHardenedIsolation, isHardenedRuntime } from "./runtime/trust-zone-hardening.js";

// image — image-reference parse/classify/warn rules (from @everdict/core; shapes stay in contracts)
export {
  classifyImageRef,
  collectHarnessImages,
  dockerAuthConfigJson,
  imageRegistryPrefix,
  imageUsesRegistryHost,
  imageWarnings,
  parseImageRef,
} from "./image/image-ref.js";

// image — display-image (avatar/logo) validation (from apps/api common)
export { validateImageRef } from "./image/display-image.js";

// trace — trace-derived usage summary (from @everdict/core; shapes stay in contracts)
export { usageFromTrace } from "./trace/usage-from-trace.js";

// registry — the version algebra every versioned registry shares (from @everdict/registry)
export {
  compareVersions,
  LATEST,
  resolveRef,
  SHARED_TENANT,
  sortVersions,
  specsEqual,
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
export { billingTenant, costOf, sumCost } from "./billing/cost.js";
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
  type UsageMeter,
  type UsageSource,
  type UsageTotals,
} from "./billing/usage.js";
