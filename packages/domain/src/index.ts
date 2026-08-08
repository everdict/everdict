// @everdict/domain — THE unique domain layer (L1). Every business rule has exactly one
// implementation here (re-architecture P1, docs/architecture/rearchitecture/00-target-architecture.md).
// Pure by construction: imports @everdict/contracts only — no I/O, no stores, no SDKs.
// Grouped by domain (scorecard/, run/, member/, …); the barrel re-exports every public symbol.

// scorecard — verdict authority + pass@k trials + diff/z-test + leaderboard/trend/models (from @everdict/suite)
export {
  type CaseDelta,
  type CaseTransition,
  caseVerdict,
  diffScorecards,
  type MeasurementCoverage,
  measurementCoverage,
  type MetricCoverage,
  metricCoverage,
  type MetricSummary,
  PRE_OUTCOME_STAGES,
  type RetryableUnmeasured,
  retryableUnmeasured,
  type ScorecardDiff,
  scorecardPassRate,
  summarizeScorecard,
  verdictSummaryOf,
} from "./scorecard/scorecard.js";
export {
  type CaseOutcome,
  caseOutcome,
  judgeGradeable,
  type ScorecardOutcomes,
  scorecardOutcomes,
} from "./scorecard/case-outcome.js";
export { type GateEvaluation, type GateInput, evaluateGate, gateAudit, gatePolicyDigest } from "./scorecard/gate.js";
export {
  type ExperimentAxis,
  type ExperimentConfound,
  type ExperimentIdentity,
  type ExperimentUnverified,
  experimentIdentity,
} from "./scorecard/experiment-identity.js";
export { flakeIndex } from "./scorecard/flake.js";
export {
  applyGradingPlan,
  caseReason,
  childKey,
  hasMeasuredJudgeVerdict,
  isJudgeMetricOf,
  sealGrading,
  selectSubsetCases,
  stripJudgeScores,
} from "./scorecard/scoring-plan.js";
export { type OpsReportInput, workspaceOpsReport } from "./scorecard/ops-report.js";
export {
  appendScoringRevision,
  currentScoringPin,
  scorePlaneDigest,
  type ScoringPassInput,
} from "./scorecard/scoring-revision.js";
export {
  composeVerdictPolicy,
  DEFAULT_VERDICT_POLICY,
  DEFAULT_VERDICT_POLICY_V1,
  evaluateVerdict,
  type PolicyResolution,
  resolvePolicyResolution,
  type StampedPolicyRef,
  type VerdictBasis,
  type VerdictEvaluation,
  verdictPolicyDigest,
  verdictPolicyIdentity,
  verdictPolicyRef,
} from "./scorecard/verdict-policy.js";
export { contentDigest, digestHex, digestUnder, digestsMatch } from "./provenance/content-digest.js";
export { type EvidenceStatus, evidenceStatus } from "./scorecard/evidence-status.js";
export {
  benjaminiHochberg,
  type CaseTrialStats,
  caseTrialStats,
  diffTrials,
  groupTrials,
  passAtK,
  twoSidedPFromZ,
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
export { decisionPassRate, headlinePassRate, preferredMetric } from "./scorecard/headline.js";

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
  type NewQueuedBatchInput,
  type NewQueuedIngestInput,
  ScorecardBatch,
  type ScorecardOrchestration,
  type ScorecardOutcomeExtras,
  type ScorecardRunError,
  type ScorecardTransition,
} from "./scorecard/scorecard-batch.js";

// run — the Run aggregate (from apps/api core/run)
export {
  attachChannelsFor,
  canReadRun,
  type NewQueuedRunInput,
  PERSONAL_RUN_KINDS,
  Run,
  type RunAudience,
  runAudience,
  runEvidenceIdentity,
  type RunTransition,
} from "./run/run.js";
export { fsFileCommand, fsTreeCommand, parseFsFile, parseFsTree, validRepoPath } from "./run/workbench-fs.js";
export {
  type NewChildRunInput,
  newScorecardChildRun,
  newSeededScorecardChildRun,
} from "./run/scorecard-child.js";
export { Approval, type ApprovalTransition, type NewPendingApprovalInput } from "./approval/approval.js";

// tracker — the eval tracker's aggregates (Initiative ⊃ Project ⊃ Issue) + the readiness arithmetic that gates
// a release (docs/tracker.md).
export {
  compareIssuesForList,
  Issue,
  ISSUE_PRIORITIES_BY_RANK,
  issueCountsByGroup,
  issueCountsByTeam,
  issueGroupKey,
  issueOrderKey,
  issueSummaryOf,
  isIssueAfterCursor,
  isOpenIssueStatus,
  orderIssueGroupCounts,
  type IssueEditInput,
  type IssueOrderable,
  type IssueReopenInput,
  type IssueStatusChangeOptions,
  type IssueTransition,
  type NewIssueInput,
  type NewIssueLinkInput,
  issueStatusCategory,
} from "./tracker/issue.js";
export {
  IssueLabel,
  type IssueLabelEditInput,
  issueLabelNameKey,
  type IssueLabelTransition,
  type NewIssueLabelInput,
  normalizeIssueLabelName,
} from "./tracker/issue-label.js";
export {
  type NewProjectInput,
  Project,
  type ProjectEditInput,
  type ProjectStatusChangeInput,
  type ProjectTransition,
} from "./tracker/project.js";
export {
  Initiative,
  type InitiativeEditInput,
  type InitiativeStatusChangeInput,
  type InitiativeTransition,
  type NewInitiativeInput,
} from "./tracker/initiative.js";
export {
  initiativeProgress,
  initiativeReadiness,
  projectRollup,
  type ProjectIssueCount,
} from "./tracker/readiness.js";
export { excerptOf, TRACKER_UPDATE_EXCERPT_LIMIT } from "./tracker/update-excerpt.js";
export {
  addCalendarDays,
  alignToStartDay,
  Cycle,
  cycleBurndown,
  type CycleCadence,
  cycleDaysRemaining,
  type CycleEditInput,
  cyclePipelinePlan,
  cycleProgress,
  cycleStateOf,
  type CycleTransition,
  daysBetween,
  issueInCycleOn,
  issueStatusOn,
  type NewCycleInput,
  nextCycleWindow,
  weekdayOf,
} from "./tracker/cycle.js";
export {
  type IssueNumberAllocation,
  type NewTeamInput,
  normalizeTeamKey,
  Team,
  type TeamEditInput,
  type TeamTransition,
} from "./tracker/team.js";

// product — the product timeline's aggregates (Product ⊃ Release over the imported version ledger) + the
// readiness arithmetic that gates a release (docs/architecture/product-timeline.md).
export {
  type NewProductInput,
  Product,
  type ProductEditInput,
  type ProductTransition,
} from "./product/product.js";
export {
  type NewReleaseInput,
  Release,
  type ReleaseEditInput,
  type ReleaseStatusChangeInput,
  type ReleaseTransition,
} from "./product/release.js";
export {
  releaseReadiness,
  type SeriesGateReading,
  type SeriesScorecardPoint,
  watchedSeries,
} from "./product/readiness.js";

// ownership — the O-track kernel (roles/envelope/checkpoint invariants; trust-kernel O2/O5/O6)
export {
  assertCheckpointForEnvelope,
  assertCompletionForRole,
  assertEnvelopeForRole,
  assertIndependentVerification,
  assertRoleProfile,
  assertTaskEnvelope,
  authorizeToolInvocation,
  type BudgetDecision,
  budgetExhausted,
  type DanglingRef,
  danglingCheckpointRefs,
  type EnvelopeDecision,
  type EnvelopeSpend,
} from "./ownership/ownership.js";

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
  harnessAuthEnv,
  type HarnessSecretMaps,
  referencesUserSecret,
  resolveEnvValues,
  resolveHarnessSecrets,
} from "./harness/harness-secrets.js";

// harness — resolved-spec version diff (base ↔ candidate)
export { diffHarnessSpecs } from "./harness/harness-diff.js";

// harness — what makes ONE instance different from its template (the display answer to "which one is this?")
export {
  summarizeInstanceVariation,
  VARIATION_CHIP_DISPLAY_LIMIT,
  type VariationChip,
} from "./harness/instance-variation.js";

// secret — reverse-usage index (which registry specs / settings integrations reference a workspace secret by name)
export { collectSecretUsages, type SecretUsage, type SecretUsageInputs } from "./secret/secret-usage.js";

// workspace settings — the Mattermost connection list (plural ∪ the legacy singular), shared by every consumer
export {
  DEFAULT_MATTERMOST_CONNECTION,
  type MattermostConnection,
  mattermostConnections,
} from "./workspace/mattermost-connections.js";

// workspace pulse — the home screen's arithmetic: the log's sparse day buckets folded into the dense series a
// dashboard draws, with "nobody measured" kept distinct from "measured zero"
export {
  activityTrend,
  calendarSpan,
  flowTrend,
  meanPassRate,
  qualityTrend,
  type WeightedRate,
  weightedMeanPassRate,
} from "./workspace/pulse.js";

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
  computeNeedsFor,
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
  IMAGE_REPOSITORY_NAME,
  PLATFORM_IMAGE_NAMESPACE,
  classifyImageRef,
  collectHarnessImages,
  dockerAuthConfigJson,
  imageRegistryPrefix,
  imageRepoFor,
  imageRepositoryOf,
  imageUsesRegistryHost,
  imageWarnings,
  isPlatformImagePath,
  parseImageRef,
  pickRegistryAuth,
  pinDigest,
  registryAuthsForImages,
  registryAuthsOf,
} from "./image/image-ref.js";

// image — display-image (avatar/logo) validation (from apps/api common)
export { validateImageRef } from "./image/display-image.js";

// trace — trace-derived usage summary (from @everdict/core; shapes stay in contracts)
export { usageFromTrace } from "./trace/usage-from-trace.js";
// trace model (otel-trace-model.md N6) — spans are the record, events are the projection
export {
  DEFAULT_SPAN_ATTR_KEYS,
  SPANS_TO_EVENTS_VERSION,
  type SpansToEventsOptions,
  spansToEvents,
} from "./trace/spans-to-events.js";
export { type EventsToSpansContext, eventsToSpans } from "./trace/events-to-spans.js";
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
// delegation — the handoff brief rendered as the markdown the delegate reads (one renderer: the seeded file,
// the trajectory marker and any later surface must not disagree about what was asked).
export { renderDelegationBrief } from "./delegation/render-brief.js";
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
export { assertCapabilityEffects, effectsRequireConsent } from "./capability/effect-contract.js";
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
  versionsBeyondKeep,
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
  canReachTeam,
  type ResourceScope,
  can,
  ownedByVisibleTeam,
  ownedByAnyVisibleTeam,
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
  CYCLE_HARVESTER,
  harvestCycle,
  harvestInitiative,
  harvestIssue,
  harvestProject,
  harvestTeam,
  INITIATIVE_HARVESTER,
  ISSUE_HARVESTER,
  PROJECT_HARVESTER,
  TEAM_HARVESTER,
} from "./knowledge/harvest-tracker.js";
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
