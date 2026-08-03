// Record shapes + their Zod schemas are the contract SSOT (@everdict/contracts); db re-exports them here
// beside the store impls as a deliberate convenience — a store consumer imports record + store together.
export type {
  RunRecord,
  RunStatus,
  ScorecardRecord,
  ScorecardStatus,
  ScorecardStep,
  MetricSummary,
  ScorecardModels,
  ScorecardOrigin,
  ScorecardSubset,
  ScorecardExport,
  ScheduleRecord,
  ScheduleOverlapPolicy,
  ScheduleRunTemplate,
  ViewRecord,
  ViewVisibility,
  BudgetUsageRow,
  BudgetLimitRow,
  NotificationKind,
  NotificationRecord,
  CommentRecord,
  TenantKeyMeta,
  ResolvedKey,
  SecretMeta,
  OAuthStatePending,
  RunnerMeta,
  PairRunnerInput,
  PairedRunner,
  ResolvedRunner,
  WorkspaceSettings,
  WorkspaceCiLink,
  WorkspaceRecord,
  WorkspaceWithRole,
  MemberRecord,
  WorkspaceInviteMeta,
  ConsumeResult,
  ConsumeOutcome,
  CreateInviteInput,
  UserProfile,
  UserProfilePatch,
} from "@everdict/contracts";
export {
  RunRecordSchema,
  RunStatusSchema,
  ScorecardRecordSchema,
  ScorecardStatusSchema,
  ScorecardStepSchema,
  MetricSummarySchema,
  ScorecardModelsSchema,
  ScorecardOriginSchema,
  ScorecardSubsetSchema,
  ScorecardExportSchema,
  ScheduleRecordSchema,
  ScheduleOverlapPolicySchema,
  ScheduleRunTemplateSchema,
  ViewRecordSchema,
  ViewVisibilitySchema,
  NotificationKindSchema,
  NotificationRecordSchema,
  CommentRecordSchema,
  WorkspaceSettingsSchema,
  WorkspaceCiLinkSchema,
} from "@everdict/contracts";

// Store ports + credential primitives live in @everdict/application-control; re-exported here beside the
// impls so a consumer narrowing a store to its port interface imports both from one module.
export type {
  AgentSessionStore,
  RunStore,
  RunListOptions,
  RecordingStore,
  ScorecardStore,
  ScorecardListFilter,
  ScheduleStore,
  SubscriptionStore,
  ViewStore,
  BrowserProfileStore,
  SkillStore,
  SkillVersionStore,
  KnowledgeEntryStore,
  CapabilityStore,
  UsageStore,
  BudgetStore,
  NotificationStore,
  NotificationListOptions,
  PlatformEventStore,
  PlatformEventListOptions,
  CommentStore,
  KnowledgeStore,
  TenantKeyStore,
  SecretStore,
  OAuthStateStore,
  RunnerJobStore,
  RunnerStore,
  WorkspaceSettingsStore,
  WorkspaceStore,
  WorkspaceInviteStore,
  UserProfileStore,
  CallbackStore,
} from "@everdict/application-control";
export { generateKey, hashKey, generateInviteToken } from "@everdict/application-control";

// Store impls (InMemory*/Pg*) + local persistence helpers stay here — the db package owns them.
export { InMemoryRunStore } from "./results/run-store.js";
export { InMemoryRecordingStore } from "./results/recording-store.js";
export { InMemoryScorecardStore } from "./results/scorecard-store.js";
export { InMemoryScheduleStore } from "./results/schedule-store.js";
export { InMemoryViewStore, PgViewStore } from "./results/view-store.js";
export { InMemoryBrowserProfileStore, PgBrowserProfileStore } from "./workspace/browser-profile-store.js";
export { InMemorySkillStore, PgSkillStore } from "./workspace/skill-store.js";
export { InMemorySubscriptionStore, PgSubscriptionStore } from "./workspace/subscription-store.js";
export { InMemorySkillVersionStore, PgSkillVersionStore } from "./workspace/skill-version-store.js";
export { InMemoryFsRevisionStore, PgFsRevisionStore } from "./workspace/fs-revision-store.js";
export { InMemoryKnowledgeEntryStore, PgKnowledgeEntryStore } from "./workspace/knowledge-entry-store.js";
export { InMemoryCapabilityStore, PgCapabilityStore } from "./workspace/capability-store.js";
export {
  InMemoryAgentMemberPreferenceStore,
  PgAgentMemberPreferenceStore,
} from "./workspace/agent-member-preference-store.js";
export { type SqlClient, type PgPool, makePool, sqlClient } from "./client.js";
export {
  type UsageRow,
  type UsageCost,
  type UsageSource,
  InMemoryUsageStore,
  PgUsageStore,
} from "./results/usage-store.js";
export { InMemoryBudgetStore, PgBudgetStore } from "./results/budget-store.js";
export { PgRunStore } from "./results/pg-run-store.js";
export { PgRecordingStore } from "./results/pg-recording-store.js";
export { PgScorecardStore } from "./results/pg-scorecard-store.js";
export { PgScheduleStore } from "./results/pg-schedule-store.js";
export {
  type Migration,
  type PreflightVerdict,
  migrate,
  preflight,
  readMigrations,
} from "./migrate.js";
export {
  InMemoryTenantKeyStore,
  PgTenantKeyStore,
  issueKey,
  issueAgentToken,
  isAgentTokenPrefix,
} from "./workspace/tenant-auth.js";
export {
  type SecretCipher,
  type EncryptedSecret,
  aesGcmCipher,
  cipherFromEnv,
  generatedCipher,
} from "./workspace/secret-cipher.js";
export { InMemorySecretStore, PgSecretStore } from "./workspace/secret-store.js";
export { InMemoryOAuthStateStore, PgOAuthStateStore, generateOAuthState } from "./workspace/oauth-state-store.js";
export { InMemoryNotificationStore, PgNotificationStore } from "./activity/notification-store.js";
export { InMemoryPlatformEventStore, PgPlatformEventStore } from "./activity/platform-event-store.js";
export { InMemoryApprovalStore } from "./activity/approval-store.js";
export { InMemoryEnvelopeStore, PgEnvelopeStore } from "./results/envelope-store.js";
export { InMemoryEventConsumerStateStore, PgEventConsumerStateStore } from "./activity/event-consumer-store.js";
export { InMemoryTrajectoryStore, PgTrajectoryStore } from "./results/trajectory-store.js";
export { ClickHouseTrajectoryStore } from "./results/clickhouse-trajectory-store.js";
export { PgApprovalStore } from "./activity/pg-approval-store.js";
export { InMemoryCommentStore, PgCommentStore } from "./activity/comment-store.js";
export { InMemoryAgentSessionStore, PgAgentSessionStore } from "./activity/agent-session-store.js";
export { InMemoryAgentTaskStore, PgAgentTaskStore } from "./activity/agent-task-store.js";
// The eval tracker (docs/tracker.md) — Initiative ⊃ Project ⊃ Issue, facts on the E0 same-tx outbox.
export { InMemoryIssueStore, PgIssueStore } from "./tracker/issue-store.js";
export { InMemoryIssueLabelStore, PgIssueLabelStore } from "./tracker/issue-label-store.js";
export { InMemoryTeamStore, PgTeamStore } from "./tracker/team-store.js";
export { InMemoryProjectStore, PgProjectStore } from "./tracker/project-store.js";
export { InMemoryInitiativeStore, PgInitiativeStore } from "./tracker/initiative-store.js";
export { InMemoryAnalysisArtifactStore, PgAnalysisArtifactStore } from "./activity/analysis-artifact-store.js";
export { InMemoryRunnerStore, PgRunnerStore, generateRunnerToken } from "./workspace/runner-store.js";
export { InMemoryWorkspaceSettingsStore, PgWorkspaceSettingsStore } from "./workspace/workspace-settings.js";
export { InMemoryWorkspaceStore, PgWorkspaceStore } from "./workspace/workspace-store.js";
export { InMemoryWorkspaceInviteStore, PgWorkspaceInviteStore } from "./workspace/workspace-invites.js";
export { InMemoryUserProfileStore, PgUserProfileStore } from "./workspace/user-profile-store.js";
export { InMemoryCallbackStore, PgCallbackStore } from "./activity/callback-store.js";
export { InMemoryRunnerJobStore, PgRunnerJobStore } from "./activity/runner-job-store.js";
export { InMemoryKnowledgeStore } from "./knowledge/in-memory-knowledge-store.js";
export { PgKnowledgeStore } from "./knowledge/pg-knowledge-store.js";
