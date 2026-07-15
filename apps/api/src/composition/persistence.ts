import {
  type BudgetStore,
  type CallbackStore,
  type CommentStore,
  InMemoryBudgetStore,
  InMemoryCallbackStore,
  InMemoryCommentStore,
  InMemoryNotificationStore,
  InMemoryOAuthStateStore,
  InMemoryRunStore,
  InMemoryRunnerJobStore,
  InMemoryRunnerStore,
  InMemoryScheduleStore,
  InMemoryScorecardStore,
  InMemorySecretStore,
  InMemoryTenantKeyStore,
  InMemoryUsageStore,
  InMemoryUserProfileStore,
  InMemoryViewStore,
  InMemoryWorkspaceInviteStore,
  InMemoryWorkspaceSettingsStore,
  InMemoryWorkspaceStore,
  type NotificationStore,
  type OAuthStateStore,
  PgBudgetStore,
  PgCallbackStore,
  PgCommentStore,
  PgNotificationStore,
  PgOAuthStateStore,
  PgRunStore,
  PgRunnerJobStore,
  PgRunnerStore,
  PgScheduleStore,
  PgScorecardStore,
  PgSecretStore,
  PgTenantKeyStore,
  PgUsageStore,
  PgUserProfileStore,
  PgViewStore,
  PgWorkspaceInviteStore,
  PgWorkspaceSettingsStore,
  PgWorkspaceStore,
  type RunStore,
  type RunnerJobStore,
  type RunnerStore,
  type ScheduleStore,
  type ScorecardStore,
  type SecretCipher,
  type SecretStore,
  type TenantKeyStore,
  type UsageStore,
  type UserProfileStore,
  type ViewStore,
  type WorkspaceInviteStore,
  type WorkspaceSettingsStore,
  type WorkspaceStore,
  cipherFromEnv,
  generatedCipher,
  makePool,
  migrate,
  sqlClient,
} from "@everdict/db";
import {
  type BenchmarkRegistry,
  type DatasetRegistry,
  type HarnessInstanceRegistry,
  type HarnessTemplateRegistry,
  InMemoryBenchmarkRegistry,
  InMemoryDatasetRegistry,
  InMemoryHarnessInstanceRegistry,
  InMemoryHarnessTemplateRegistry,
  InMemoryJudgeRegistry,
  InMemoryModelRegistry,
  InMemoryRubricRegistry,
  InMemoryRuntimeRegistry,
  type JudgeRegistry,
  type ModelRegistry,
  PgBenchmarkRegistry,
  PgDatasetRegistry,
  PgHarnessInstanceRegistry,
  PgHarnessTemplateRegistry,
  PgJudgeRegistry,
  PgModelRegistry,
  PgRubricRegistry,
  PgRuntimeRegistry,
  type RubricRegistry,
  type RuntimeRegistry,
} from "@everdict/registry";

export interface Persistence {
  store: RunStore;
  scorecardStore: ScorecardStore;
  keyStore: TenantKeyStore;
  harnessTemplateRegistry: HarnessTemplateRegistry; // harness category (template structure)
  harnessInstanceRegistry: HarnessInstanceRegistry; // individual harness (template+pins → resolved)
  datasetRegistry: DatasetRegistry;
  benchmarkRegistry: BenchmarkRegistry;
  judgeRegistry: JudgeRegistry;
  rubricRegistry: RubricRegistry;
  modelRegistry: ModelRegistry;
  runtimeRegistry: RuntimeRegistry;
  settingsStore: WorkspaceSettingsStore; // workspace settings (metering policy, etc.) — always available
  workspaceStore: WorkspaceStore; // workspace membership (create/switch) — always available
  userProfileStore: UserProfileStore; // user profile (name/username/avatar) — always available
  inviteStore: WorkspaceInviteStore; // member invites (token/link redemption) — always available
  secretStore: SecretStore; // always available (on by default) — KEK is EVERDICT_SECRETS_KEY, else an ephemeral key is auto-generated
  oauthStateStore: OAuthStateStore; // one-shot pending state for OAuth authorize→callback
  runnerStore: RunnerStore; // self-hosted runners (personal device pairing) — only the SHA-256 hash of the pairing token is stored
  runnerJobStore: RunnerJobStore; // store-backed self-hosted lease queue (multi-replica StoreRunnerHub); unused by the in-memory hub
  scheduleStore: ScheduleStore; // scheduled (cron) scorecards — stored RunScorecardInput + cron expression (SSOT, mutable)
  notificationStore: NotificationStore; // personal notification feed (bell inbox) — records run/scorecard completion with recipient=subject
  commentStore: CommentStore; // resource comments (datasets, etc.) — collaborative discussion
  viewStore: ViewStore; // saved scorecard-analysis Views (named AnalysisConfig, private|workspace) — live re-run
  // Front-door callback bodies (multi-replica rendezvous) — Pg-backed when DATABASE_URL is set, else in-memory
  // (single process; the in-process rendezvous is equivalent there). docs/architecture/completion-stream-callback.md
  callbackStore: CallbackStore;
  usageStore: UsageStore; // durable meter-only billing usage — the in-memory UsageMeter write-throughs + hydrates from it
  budgetStore: BudgetStore; // durable per-tenant budget (usage + limits) — the in-memory BudgetTracker write-throughs + hydrates from it
}

// At-rest encryption KEK: use EVERDICT_SECRETS_KEY (base64 32B) if present, otherwise auto-generate an ephemeral key
// to keep the secrets feature "on by default" (no branch / no fail-closed). On auto-generation, warn once about Pg persistence.
function resolveSecretCipher(): SecretCipher {
  const fromEnv = cipherFromEnv();
  if (fromEnv) return fromEnv;
  console.error(
    "▶ EVERDICT_SECRETS_KEY unset — auto-generating an ephemeral KEK to enable the secrets feature (on by default). " +
      "For persistent (Postgres) operation, pin EVERDICT_SECRETS_KEY (base64 32B) — an ephemeral key changes every restart and cannot decrypt existing secrets.",
  );
  return generatedCipher();
}

// DATABASE_URL → Postgres (migrations applied at startup), else in-memory.
// The secret store is always active (on by default). The at-rest encryption KEK is EVERDICT_SECRETS_KEY (base64 32B); if unset, an ephemeral key is
// auto-generated — safe in-memory since it's volatile, but persistent Pg operation must pin the key via EVERDICT_SECRETS_KEY (restart decryption).
export async function makePersistence(): Promise<Persistence> {
  const cipher = resolveSecretCipher();
  const url = process.env.DATABASE_URL;
  if (!url) {
    const workspaceStore = new InMemoryWorkspaceStore();
    const harnessTemplateRegistry = new InMemoryHarnessTemplateRegistry();
    return {
      store: new InMemoryRunStore(),
      scorecardStore: new InMemoryScorecardStore(),
      keyStore: new InMemoryTenantKeyStore(),
      harnessTemplateRegistry,
      harnessInstanceRegistry: new InMemoryHarnessInstanceRegistry(harnessTemplateRegistry),
      datasetRegistry: new InMemoryDatasetRegistry(),
      benchmarkRegistry: new InMemoryBenchmarkRegistry(),
      judgeRegistry: new InMemoryJudgeRegistry(),
      rubricRegistry: new InMemoryRubricRegistry(),
      modelRegistry: new InMemoryModelRegistry(),
      runtimeRegistry: new InMemoryRuntimeRegistry(),
      settingsStore: new InMemoryWorkspaceSettingsStore(),
      workspaceStore,
      userProfileStore: new InMemoryUserProfileStore(),
      inviteStore: new InMemoryWorkspaceInviteStore(workspaceStore),
      secretStore: new InMemorySecretStore(cipher),
      oauthStateStore: new InMemoryOAuthStateStore(),
      runnerStore: new InMemoryRunnerStore(),
      runnerJobStore: new InMemoryRunnerJobStore(),
      scheduleStore: new InMemoryScheduleStore(),
      notificationStore: new InMemoryNotificationStore(),
      commentStore: new InMemoryCommentStore(),
      viewStore: new InMemoryViewStore(),
      callbackStore: new InMemoryCallbackStore(),
      usageStore: new InMemoryUsageStore(),
      budgetStore: new InMemoryBudgetStore(),
    };
  }
  const client = sqlClient(makePool(url));
  const { applied } = await migrate(client);
  if (applied.length > 0) console.error(`▶ db migrations applied: ${applied.join(", ")}`);
  const harnessTemplateRegistry = new PgHarnessTemplateRegistry(client);
  return {
    store: new PgRunStore(client),
    scorecardStore: new PgScorecardStore(client),
    keyStore: new PgTenantKeyStore(client),
    harnessTemplateRegistry,
    harnessInstanceRegistry: new PgHarnessInstanceRegistry(client, harnessTemplateRegistry),
    datasetRegistry: new PgDatasetRegistry(client),
    benchmarkRegistry: new PgBenchmarkRegistry(client),
    judgeRegistry: new PgJudgeRegistry(client),
    rubricRegistry: new PgRubricRegistry(client),
    modelRegistry: new PgModelRegistry(client),
    runtimeRegistry: new PgRuntimeRegistry(client),
    settingsStore: new PgWorkspaceSettingsStore(client),
    workspaceStore: new PgWorkspaceStore(client),
    userProfileStore: new PgUserProfileStore(client),
    inviteStore: new PgWorkspaceInviteStore(client),
    secretStore: new PgSecretStore(client, cipher),
    oauthStateStore: new PgOAuthStateStore(client),
    runnerStore: new PgRunnerStore(client),
    runnerJobStore: new PgRunnerJobStore(client),
    scheduleStore: new PgScheduleStore(client),
    notificationStore: new PgNotificationStore(client),
    commentStore: new PgCommentStore(client),
    viewStore: new PgViewStore(client),
    callbackStore: new PgCallbackStore(client),
    usageStore: new PgUsageStore(client),
    budgetStore: new PgBudgetStore(client),
  };
}
