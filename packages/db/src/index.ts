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
  ViewStore,
  BrowserProfileStore,
  SkillStore,
  UsageStore,
  BudgetStore,
  NotificationStore,
  NotificationListOptions,
  CommentStore,
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
export { InMemoryTenantKeyStore, PgTenantKeyStore, issueKey } from "./workspace/tenant-auth.js";
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
export { InMemoryCommentStore, PgCommentStore } from "./activity/comment-store.js";
export { InMemoryAgentSessionStore, PgAgentSessionStore } from "./activity/agent-session-store.js";
export { InMemoryRunnerStore, PgRunnerStore, generateRunnerToken } from "./workspace/runner-store.js";
export { InMemoryWorkspaceSettingsStore, PgWorkspaceSettingsStore } from "./workspace/workspace-settings.js";
export { InMemoryWorkspaceStore, PgWorkspaceStore } from "./workspace/workspace-store.js";
export { InMemoryWorkspaceInviteStore, PgWorkspaceInviteStore } from "./workspace/workspace-invites.js";
export { InMemoryUserProfileStore, PgUserProfileStore } from "./workspace/user-profile-store.js";
export { InMemoryCallbackStore, PgCallbackStore } from "./activity/callback-store.js";
export { InMemoryRunnerJobStore, PgRunnerJobStore } from "./activity/runner-job-store.js";
