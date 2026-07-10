// @everdict/application-control — L2b, the control-plane use-cases + ports (re-architecture P2,
// docs/architecture/rearchitecture/00-target-architecture.md). Batch driving, store/dispatch ports,
// and (incrementally) the api services move here; composition roots (apps/*) bind the adapters.
// Imports contracts + domain only. NEVER enters the agent cone (control-plane side).
export { type Dispatch, runSuite } from "./run-suite.js";

// Store ports (interfaces only) — the impls (InMemory*/Pg*) live in @everdict/db, which binds these.
export type { CallbackStore } from "./ports/callback-store.js";
export type { CommentStore } from "./ports/comment-store.js";
export type { NotificationListOptions, NotificationStore } from "./ports/notification-store.js";
export type { BudgetStore } from "./ports/budget-store.js";
export type { RunListOptions, RunStore } from "./ports/run-store.js";
export type { ScheduleStore } from "./ports/schedule-store.js";
export type { ScorecardListFilter, ScorecardStore } from "./ports/scorecard-store.js";
export type { UsageStore } from "./ports/usage-store.js";
export type { ViewStore } from "./ports/view-store.js";
export type { OAuthStateStore } from "./ports/oauth-state-store.js";
export type { RunnerStore } from "./ports/runner-store.js";
export type { SecretStore } from "./ports/secret-store.js";
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
export type { RuntimeListEntry, RuntimeRegistry } from "./ports/runtime-registry.js";

// Control-plane use-case services (the api services move here incrementally — re-architecture P2d).
export { type CreateViewInput, type UpdateViewInput, ViewService, type ViewServiceDeps } from "./view/view-service.js";
export {
  COMMENT_RESOURCE_TYPES,
  type CommentResourceType,
  CommentService,
  type CommentServiceDeps,
} from "./comment/comment-service.js";
export { deleteDatasetVersion } from "./dataset/dataset-service.js";
export { deleteHarnessVersion, harnessIsPrivate, harnessVisibleTo } from "./harness/harness-service.js";
export {
  type PairRunnerBody,
  PairRunnerBodySchema,
  RUNNER_CAPABILITIES,
  RunnerService,
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
export {
  normalizeVersionTags,
  setVersionTags,
  type VersionTaggable,
  VersionTagsBodySchema,
} from "./version-tag/version-tag-service.js";
export type { MattermostClient, MattermostPost } from "./ports/mattermost-client.js";
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
export { createLimiter, type Limiter } from "./concurrency/limiter.js";
export {
  type CaseExportStream,
  type TraceSinkConfigView,
  TraceSinkService,
  type TraceSinkServiceDeps,
} from "./trace-sink/trace-sink-service.js";
