import type { LeaderElector } from "@everdict/application-control";
import { soleLeader } from "@everdict/application-control";
import type {
  AgentMemberPreferenceStore,
  AgentTaskStore,
  ApprovalStore,
  CycleStore,
  EnvelopeStore,
  EventConsumerStateStore,
  FsRevisionStore,
  InitiativeStore,
  InitiativeUpdateStore,
  IssueLabelStore,
  IssueStore,
  ProjectStore,
  ProjectUpdateStore,
  TeamStore,
  TrajectoryStore,
  WorkflowStateStore,
} from "@everdict/application-control";
import {
  type BrowserProfileStore,
  type BudgetStore,
  type CallbackStore,
  type CapabilityStore,
  ClickHouseTrajectoryStore,
  type CommentStore,
  InMemoryAgentMemberPreferenceStore,
  InMemoryAgentTaskStore,
  InMemoryApprovalStore,
  InMemoryBrowserProfileStore,
  InMemoryBudgetStore,
  InMemoryCallbackStore,
  InMemoryCapabilityStore,
  InMemoryCommentStore,
  InMemoryCycleStore,
  InMemoryEnvelopeStore,
  InMemoryEventConsumerStateStore,
  InMemoryFsRevisionStore,
  InMemoryInitiativeStore,
  InMemoryInitiativeUpdateStore,
  InMemoryIssueLabelStore,
  InMemoryIssueStore,
  InMemoryKnowledgeEntryStore,
  InMemoryKnowledgeStore,
  InMemoryNotificationStore,
  InMemoryOAuthStateStore,
  InMemoryPlatformEventStore,
  InMemoryProjectStore,
  InMemoryProjectUpdateStore,
  InMemoryRecordingStore,
  InMemoryRunStore,
  InMemoryRunnerJobStore,
  InMemoryRunnerStore,
  InMemoryScheduleStore,
  InMemoryScorecardStore,
  InMemorySecretStore,
  InMemorySkillStore,
  InMemorySkillVersionStore,
  InMemorySubscriptionStore,
  InMemoryTeamStore,
  InMemoryTenantKeyStore,
  InMemoryTrajectoryStore,
  InMemoryUsageStore,
  InMemoryUserProfileStore,
  InMemoryViewStore,
  InMemoryWorkflowStateStore,
  InMemoryWorkspaceInviteStore,
  InMemoryWorkspaceSettingsStore,
  InMemoryWorkspaceStore,
  type KnowledgeEntryStore,
  type KnowledgeStore,
  type NotificationStore,
  type OAuthStateStore,
  PgAgentMemberPreferenceStore,
  PgAgentTaskStore,
  PgApprovalStore,
  PgBrowserProfileStore,
  PgBudgetStore,
  PgCallbackStore,
  PgCapabilityStore,
  PgCommentStore,
  PgCycleStore,
  PgEnvelopeStore,
  PgEventConsumerStateStore,
  PgFsRevisionStore,
  PgInitiativeStore,
  PgInitiativeUpdateStore,
  PgIssueLabelStore,
  PgIssueStore,
  PgKnowledgeEntryStore,
  PgKnowledgeStore,
  PgLeaderElector,
  PgNotificationStore,
  PgOAuthStateStore,
  PgPlatformEventStore,
  PgProjectStore,
  PgProjectUpdateStore,
  PgRecordingStore,
  PgRunStore,
  PgRunnerJobStore,
  PgRunnerStore,
  PgScheduleStore,
  PgScorecardStore,
  PgSecretStore,
  PgSkillStore,
  PgSkillVersionStore,
  PgSubscriptionStore,
  PgTeamStore,
  PgTenantKeyStore,
  PgTrajectoryStore,
  PgUsageStore,
  PgUserProfileStore,
  PgViewStore,
  PgWorkflowStateStore,
  PgWorkspaceInviteStore,
  PgWorkspaceSettingsStore,
  PgWorkspaceStore,
  type PlatformEventStore,
  type RecordingStore,
  type RunStore,
  type RunnerJobStore,
  type RunnerStore,
  type ScheduleStore,
  type ScorecardStore,
  type SecretCipher,
  type SecretStore,
  type SkillStore,
  type SkillVersionStore,
  type SubscriptionStore,
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
  type AgentRegistry,
  type BenchmarkRegistry,
  type DatasetRegistry,
  type HarnessInstanceRegistry,
  type HarnessTemplateRegistry,
  InMemoryAgentRegistry,
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
  PgAgentRegistry,
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
import { httpOfflineTokenMinter } from "../infrastructure/oauth/offline-token-minter.js";
import { CONTROL_PLANE_ROLE, REPLICA_ID } from "./replica.js";

export interface Persistence {
  store: RunStore;
  recordingStore: RecordingStore; // durable replay recording (frames/logs/env/runtime tracks) — persistent by default
  scorecardStore: ScorecardStore;
  keyStore: TenantKeyStore;
  harnessTemplateRegistry: HarnessTemplateRegistry; // harness category (template structure)
  harnessInstanceRegistry: HarnessInstanceRegistry; // individual harness (template+pins → resolved)
  datasetRegistry: DatasetRegistry;
  benchmarkRegistry: BenchmarkRegistry;
  judgeRegistry: JudgeRegistry;
  rubricRegistry: RubricRegistry;
  modelRegistry: ModelRegistry;
  agentRegistry: AgentRegistry; // the workspace's conversational-agent configuration (instructions + MCP tool servers + model)
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
  platformEventStore: PlatformEventStore; // append-only platform-event log (agent-automation A1) — durable facts + reconcile cursor
  approvalStore: ApprovalStore; // durable agent approvals (A6) — the parked ask survives an agent-service restart
  envelopeStore: EnvelopeStore; // envelope spend ledger (§5.2 P4) — headroom reads + caused-cost settles
  eventConsumerStateStore: EventConsumerStateStore; // durable consumer cursors + dead letters (E1)
  trajectoryStore: TrajectoryStore; // the OWNED trajectory store (P5 rung 1) — sealed evidence per run
  commentStore: CommentStore; // resource comments (datasets, etc.) — collaborative discussion
  knowledgeStore: KnowledgeStore; // workspace knowledge graph — append-only mention/edge + upsert node projection
  knowledgeEntryStore: KnowledgeEntryStore; // knowledge entries (reified claims) — dual-scoped private|workspace
  fsRevisionStore: FsRevisionStore; // workspace-filesystem publication ledger — who published which revision, when
  subscriptionStore: SubscriptionStore; // subscription registry (event → reaction rules, E3 §6)
  viewStore: ViewStore; // saved scorecard-analysis Views (named AnalysisConfig, private|workspace) — live re-run
  taskStore: AgentTaskStore; // workspace task ledger — cross-turn, cross-agent coordination (agent-teams)
  // The eval tracker (docs/tracker.md) — Initiative ⊃ Project ⊃ Issue, the "why we evaluate" layer.
  teamStore: TeamStore;
  cycleStore: CycleStore;
  workflowStateStore: WorkflowStateStore;
  projectUpdateStore: ProjectUpdateStore;
  issueStore: IssueStore;
  issueLabelStore: IssueLabelStore;
  projectStore: ProjectStore;
  initiativeStore: InitiativeStore;
  initiativeUpdateStore: InitiativeUpdateStore; // the goal's own posted-update timeline (health + the sentence)
  browserProfileStore: BrowserProfileStore; // saved authenticated browser profiles (browser-profiles S2) — personal metadata
  skillStore: SkillStore; // workspace Skills (SKILL.md procedures the members own) — dual-scoped private|workspace
  skillVersionStore: SkillVersionStore; // a skill's stamped, immutable versions — the line its working copy moves along
  capabilityStore: CapabilityStore; // Capability Store (mcp|code|skill) — versioned + per-capability visibility (private|workspace|subset|public)
  // Per-MEMBER agent overlay — which of the workspace's tools + skills each member wants their own agent to carry
  agentMemberPreferenceStore: AgentMemberPreferenceStore;
  // Front-door callback bodies (multi-replica rendezvous) — Pg-backed when DATABASE_URL is set, else in-memory
  // (single process; the in-process rendezvous is equivalent there). docs/architecture/completion-stream-callback.md
  callbackStore: CallbackStore;
  usageStore: UsageStore; // durable meter-only billing usage — the in-memory UsageMeter write-throughs + hydrates from it
  budgetStore: BudgetStore; // durable per-tenant budget (usage + limits) — the in-memory BudgetTracker write-throughs + hydrates from it
  cipher: SecretCipher; // at-rest AES-256-GCM cipher (EVERDICT_SECRETS_KEY KEK) — shared by secrets + the browser-profile login blob (S3)
  // Who runs the singleton control-plane loops (docs/architecture/multi-replica.md). Postgres → a renewed
  // lease row, so exactly one replica scales pools, recovers at boot and settles other processes' stale rows;
  // no Postgres → `soleLeader`, the single-process shape where every gated loop simply runs.
  leader: LeaderElector;
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
  // The trajectory store's ops-scale rung (native-observability N-O1 rung 2): EVERDICT_CLICKHOUSE_URL swaps
  // ONLY this store to ClickHouse — the port makes the swap invisible to every consumer (door, browse,
  // quota meter, retention, perception). Everything else keeps its DATABASE_URL choice.
  const clickhouseTrajectories = await (async () => {
    const chUrl = process.env.EVERDICT_CLICKHOUSE_URL;
    if (!chUrl) return undefined;
    const store = new ClickHouseTrajectoryStore({
      url: chUrl,
      ...(process.env.EVERDICT_CLICKHOUSE_DATABASE ? { database: process.env.EVERDICT_CLICKHOUSE_DATABASE } : {}),
    });
    await store.ensureSchema();
    console.log("▶ trajectory store: ClickHouse (ops-scale rung)");
    return store;
  })();
  // Refresh-grant client for offline_token secrets — injected into the SecretStore so it can exchange a stored
  // refresh token for a fresh access token on read (OAuth I/O stays out of @everdict/db).
  const offlineTokenMinter = httpOfflineTokenMinter();
  const url = process.env.DATABASE_URL;
  if (!url) {
    const workspaceStore = new InMemoryWorkspaceStore();
    const harnessTemplateRegistry = new InMemoryHarnessTemplateRegistry();
    // The run store and the event log form the E0 outbox pair — the store appends transition facts itself.
    const platformEventStore = new InMemoryPlatformEventStore();
    // Postgres deletes a label and strips it off every issue in one CTE (mig 0107). In memory the two stores are
    // separate objects, so the composition root hands the issues over — otherwise a delete would leave `labelIds`
    // pointing at a label that no longer exists, and the two bindings would not be interchangeable.
    const inMemoryIssues = new InMemoryIssueStore();
    const inMemoryIssueLabels = new InMemoryIssueLabelStore();
    inMemoryIssueLabels.attachIssues(inMemoryIssues);
    return {
      store: new InMemoryRunStore(platformEventStore),
      recordingStore: new InMemoryRecordingStore(),
      scorecardStore: new InMemoryScorecardStore(platformEventStore),
      keyStore: new InMemoryTenantKeyStore(),
      harnessTemplateRegistry,
      harnessInstanceRegistry: new InMemoryHarnessInstanceRegistry(harnessTemplateRegistry),
      datasetRegistry: new InMemoryDatasetRegistry(),
      benchmarkRegistry: new InMemoryBenchmarkRegistry(),
      judgeRegistry: new InMemoryJudgeRegistry(),
      rubricRegistry: new InMemoryRubricRegistry(),
      modelRegistry: new InMemoryModelRegistry(),
      agentRegistry: new InMemoryAgentRegistry(),
      runtimeRegistry: new InMemoryRuntimeRegistry(),
      settingsStore: new InMemoryWorkspaceSettingsStore(),
      workspaceStore,
      userProfileStore: new InMemoryUserProfileStore(),
      inviteStore: new InMemoryWorkspaceInviteStore(workspaceStore),
      secretStore: new InMemorySecretStore(cipher, undefined, offlineTokenMinter),
      oauthStateStore: new InMemoryOAuthStateStore(),
      runnerStore: new InMemoryRunnerStore(),
      runnerJobStore: new InMemoryRunnerJobStore(),
      scheduleStore: new InMemoryScheduleStore(),
      notificationStore: new InMemoryNotificationStore(),
      platformEventStore,
      approvalStore: new InMemoryApprovalStore(platformEventStore),
      envelopeStore: new InMemoryEnvelopeStore(),
      eventConsumerStateStore: new InMemoryEventConsumerStateStore(),
      trajectoryStore: clickhouseTrajectories ?? new InMemoryTrajectoryStore(),
      commentStore: new InMemoryCommentStore(),
      knowledgeStore: new InMemoryKnowledgeStore(),
      knowledgeEntryStore: new InMemoryKnowledgeEntryStore(),
      fsRevisionStore: new InMemoryFsRevisionStore(),
      subscriptionStore: new InMemorySubscriptionStore(),
      viewStore: new InMemoryViewStore(),
      taskStore: new InMemoryAgentTaskStore(),
      teamStore: new InMemoryTeamStore(),
      cycleStore: new InMemoryCycleStore(),
      workflowStateStore: new InMemoryWorkflowStateStore(),
      projectUpdateStore: new InMemoryProjectUpdateStore(),
      issueStore: inMemoryIssues,
      issueLabelStore: inMemoryIssueLabels,
      projectStore: new InMemoryProjectStore(),
      initiativeStore: new InMemoryInitiativeStore(),
      initiativeUpdateStore: new InMemoryInitiativeUpdateStore(),
      browserProfileStore: new InMemoryBrowserProfileStore(),
      skillStore: new InMemorySkillStore(),
      skillVersionStore: new InMemorySkillVersionStore(),
      capabilityStore: new InMemoryCapabilityStore(),
      agentMemberPreferenceStore: new InMemoryAgentMemberPreferenceStore(),
      callbackStore: new InMemoryCallbackStore(),
      usageStore: new InMemoryUsageStore(),
      budgetStore: new InMemoryBudgetStore(),
      cipher,
      leader: soleLeader,
    };
  }
  const client = sqlClient(makePool(url));
  const { applied } = await migrate(client);
  if (applied.length > 0) console.error(`▶ db migrations applied: ${applied.join(", ")}`);
  const harnessTemplateRegistry = new PgHarnessTemplateRegistry(client);
  return {
    store: new PgRunStore(client),
    recordingStore: new PgRecordingStore(client),
    scorecardStore: new PgScorecardStore(client),
    keyStore: new PgTenantKeyStore(client),
    harnessTemplateRegistry,
    harnessInstanceRegistry: new PgHarnessInstanceRegistry(client, harnessTemplateRegistry),
    datasetRegistry: new PgDatasetRegistry(client),
    benchmarkRegistry: new PgBenchmarkRegistry(client),
    judgeRegistry: new PgJudgeRegistry(client),
    rubricRegistry: new PgRubricRegistry(client),
    modelRegistry: new PgModelRegistry(client),
    agentRegistry: new PgAgentRegistry(client),
    runtimeRegistry: new PgRuntimeRegistry(client),
    settingsStore: new PgWorkspaceSettingsStore(client),
    workspaceStore: new PgWorkspaceStore(client),
    userProfileStore: new PgUserProfileStore(client),
    inviteStore: new PgWorkspaceInviteStore(client),
    secretStore: new PgSecretStore(client, cipher, offlineTokenMinter),
    oauthStateStore: new PgOAuthStateStore(client),
    runnerStore: new PgRunnerStore(client),
    runnerJobStore: new PgRunnerJobStore(client),
    scheduleStore: new PgScheduleStore(client),
    notificationStore: new PgNotificationStore(client),
    platformEventStore: new PgPlatformEventStore(client),
    approvalStore: new PgApprovalStore(client),
    envelopeStore: new PgEnvelopeStore(client),
    eventConsumerStateStore: new PgEventConsumerStateStore(client),
    trajectoryStore: clickhouseTrajectories ?? new PgTrajectoryStore(client),
    commentStore: new PgCommentStore(client),
    knowledgeStore: new PgKnowledgeStore(client),
    knowledgeEntryStore: new PgKnowledgeEntryStore(client),
    fsRevisionStore: new PgFsRevisionStore(client),
    subscriptionStore: new PgSubscriptionStore(client),
    viewStore: new PgViewStore(client),
    taskStore: new PgAgentTaskStore(client),
    teamStore: new PgTeamStore(client),
    cycleStore: new PgCycleStore(client),
    workflowStateStore: new PgWorkflowStateStore(client),
    projectUpdateStore: new PgProjectUpdateStore(client),
    issueStore: new PgIssueStore(client),
    issueLabelStore: new PgIssueLabelStore(client),
    projectStore: new PgProjectStore(client),
    initiativeStore: new PgInitiativeStore(client),
    initiativeUpdateStore: new PgInitiativeUpdateStore(client),
    browserProfileStore: new PgBrowserProfileStore(client),
    skillStore: new PgSkillStore(client),
    skillVersionStore: new PgSkillVersionStore(client),
    capabilityStore: new PgCapabilityStore(client),
    agentMemberPreferenceStore: new PgAgentMemberPreferenceStore(client),
    callbackStore: new PgCallbackStore(client),
    usageStore: new PgUsageStore(client),
    budgetStore: new PgBudgetStore(client),
    leader: new PgLeaderElector(client, { role: CONTROL_PLANE_ROLE, holder: REPLICA_ID }),
    cipher,
  };
}
