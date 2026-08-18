import type {
  CancellationStore,
  CapabilityGenerationStore,
  CaseReceiptStore,
  ConstitutionApprovalStore,
  ConstitutionalPublisher,
  ExecutionAttemptStore,
  HandoffCheckpointStore,
  LeaderElector,
  PublicationOperationStore,
  ReplicaRegistry,
  ScoringStageStore,
  VerificationDecisionStore,
} from "@everdict/application-control";
import {
  InMemoryCancellationStore,
  InMemoryCaseReceiptStore,
  InMemoryExecutionAttemptStore,
  InMemoryPublicationOperationStore,
  attemptParentAuthority,
  soleLeader,
  soloReplicas,
} from "@everdict/application-control";
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
  ProductStore,
  ProductVersionStore,
  ProjectStore,
  ProjectUpdateStore,
  ReleaseStore,
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
  InMemoryHandoffCheckpointStore,
  InMemoryInitiativeStore,
  InMemoryInitiativeUpdateStore,
  InMemoryIssueLabelStore,
  InMemoryIssueStore,
  InMemoryKnowledgeEntryStore,
  InMemoryKnowledgeStore,
  InMemoryNotificationStore,
  InMemoryOAuthStateStore,
  InMemoryPlatformEventStore,
  InMemoryProductStore,
  InMemoryProductVersionStore,
  InMemoryProjectStore,
  InMemoryProjectUpdateStore,
  InMemoryRecordingStore,
  InMemoryReleaseStore,
  InMemoryRunStore,
  InMemoryRunnerJobStore,
  InMemoryRunnerStore,
  InMemoryScheduleStore,
  InMemoryScorecardStore,
  InMemoryScoringStageStore,
  InMemorySecretStore,
  InMemorySkillStore,
  InMemorySkillVersionStore,
  InMemorySubscriptionStore,
  InMemoryTeamStore,
  InMemoryTenantKeyStore,
  InMemoryTrajectoryStore,
  InMemoryUsageStore,
  InMemoryUserProfileStore,
  InMemoryVerificationDecisionStore,
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
  PgCancellationStore,
  PgCapabilityGenerationStore,
  PgCapabilityStore,
  PgCaseReceiptStore,
  PgCommentStore,
  PgConstitutionApprovalStore,
  PgCycleStore,
  PgEnvelopeStore,
  PgEventConsumerStateStore,
  PgExecutionAttemptStore,
  PgFsRevisionStore,
  PgHandoffCheckpointStore,
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
  PgProductStore,
  PgProductVersionStore,
  PgProjectStore,
  PgProjectUpdateStore,
  PgPublicationOperationStore,
  PgRecordingStore,
  PgReleaseStore,
  PgReplicaRegistry,
  PgRunStore,
  PgRunnerJobStore,
  PgRunnerStore,
  PgScheduleStore,
  PgScorecardStore,
  PgScoringStageStore,
  PgSecretStore,
  PgSkillStore,
  PgSkillVersionStore,
  PgSubscriptionStore,
  PgTeamStore,
  PgTenantKeyStore,
  PgTrajectoryStore,
  PgUsageStore,
  PgUserProfileStore,
  PgVerificationDecisionStore,
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
import { pgConstitutionalPublisher } from "../infrastructure/registry/constitutional-publisher.js";
import { CONTROL_PLANE_ROLE, REPLICA_ID } from "./replica.js";

export interface Persistence {
  store: RunStore;
  // The scoring STAGE (mig 0149) — where a pass accumulates judgments before it owns them. Written and not
  // yet read (expand step, docs/architecture/scoring-plane-revisions.md).
  scoringStageStore: ScoringStageStore;
  recordingStore: RecordingStore; // durable replay recording (frames/logs/env/runtime tracks) — persistent by default
  // Where a case's canonical outcome is decided (mig 0175): one receipt per (scorecard, case, trial), claimed
  // by the attempt that commits. Written beside the ledger while the two are compared.
  caseReceiptStore: CaseReceiptStore;
  // The PHYSICAL execution ledger (mig 0182): one unconditional row per physical execution, with a state.
  // Phase-1 dual-write — stamped beside the commit points, read by nothing (arch-review 42).
  executionAttemptStore: ExecutionAttemptStore;
  // The cancel teardown's durable owner (mig 0184, generalized by 0186): a scorecard OR a standalone run
  // whose CANCELLED decision committed but whose live work may still be running. Swept by the
  // CancellationCoordinator (arch-review 47 §5.2, arch-review 52 Wave 3).
  cancellationStore: CancellationStore;
  // The publication's durable owner (mig 0188, arch-review 53 Wave C) — one row per settlement.
  publicationOperationStore: PublicationOperationStore;
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
  // Handoff checkpoints (ownership O6) — where an autonomous task's resumable state transfer outlives the
  // process that wrote it. Append-only: a predecessor must not rewrite evidence its successor already used.
  handoffCheckpointStore: HandoffCheckpointStore;
  verificationDecisionStore: VerificationDecisionStore;
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
  // The product timeline (docs/architecture/product-timeline.md) — Product ⊃ Release over the version ledger.
  productStore: ProductStore;
  releaseStore: ReleaseStore;
  // The capability resolution generations a ship's terminal commit conditions on (mig 0163). Postgres only —
  // the fence is a subquery, and an in-memory registry has no mutation counter to compare (the in-memory
  // release store abstains on it, as it does on every cross-row guard).
  capabilityGenerationStore?: CapabilityGenerationStore;
  // The receipts constitutional declarations leave (mig 0165) — Postgres only, like every other provenance
  // ledger. Without it a declaration is authorized but unrecorded, which the reader reports as unapproved.
  constitutionApprovalStore?: ConstitutionApprovalStore;
  constitutionalPublisher?: ConstitutionalPublisher;
  productVersionStore: ProductVersionStore;
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
  // WHICH control planes are alive (docs/architecture/multi-replica.md) — boot recovery reclaims only records
  // whose owning replica stopped heartbeating. No Postgres → `soloReplicas`, i.e. no peers, so recovery
  // reclaims every in-flight record exactly as it did before.
  replicas: ReplicaRegistry;
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
    // The scoring FENCE is a cross-row condition (a child write commits only while the named pass still owns
    // its parent's marker). Postgres evaluates it with a sub-select in the write statement; in memory the two
    // stores are separate objects, so the composition hands the run store a reader for the scorecard's marker
    // — otherwise the dev binding would be the one place a superseded pass could still write.
    const inMemoryScorecards = new InMemoryScorecardStore(platformEventStore);
    const inMemoryRuns = new InMemoryRunStore(platformEventStore);
    inMemoryRuns.attachScorecards(inMemoryScorecards);
    // Same shape for the release gate's CROSS-AGGREGATE policy guard: a ship decision commits only while the
    // product's policy version is still the one it read. Postgres evaluates that as an EXISTS in the write
    // statement; in memory the composition hands the release store a reader for the product's version.
    const inMemoryProducts = new InMemoryProductStore();
    const inMemoryReleases = new InMemoryReleaseStore();
    const inMemoryProductVersions = new InMemoryProductVersionStore();
    inMemoryReleases.attachProducts(inMemoryProducts);
    // …and the aggregate cascade the Pg store does in ONE statement. Children live in sibling stores here, so
    // the composition is where the aggregate boundary is expressible at all.
    inMemoryProducts.attachChildren((tenant, productId) => {
      const releases = inMemoryReleases.removeForProduct(tenant, productId);
      const versions = inMemoryProductVersions.removeAllForProduct(tenant, productId);
      return { releases, versions };
    });
    // The settle's receipt-count CAS (review 40, expectReceiptCount): Postgres answers it with a sub-select
    // in the terminal write's own statement; in memory the pairing is explicit, like the fences above.
    const inMemoryReceipts = new InMemoryCaseReceiptStore();
    inMemoryScorecards.attachReceipts((id) => inMemoryReceipts.countFor(id));
    const inMemoryCancellations = new InMemoryCancellationStore();
    // …and the publication ledger's in-memory twin, paired to the scorecard store the same way (the operation
    // row is inserted by the settle's own write — see `attachPublications`).
    const inMemoryPublications = new InMemoryPublicationOperationStore();
    // The settle→operation pair (arch-review 51 P0) — Pg does this inside the settle statement; in memory
    // the pairing is the attach, applied right after a matched abort settle.
    inMemoryScorecards.attachPublications((operation) => void inMemoryPublications.open(operation).catch(() => {}));
    inMemoryScorecards.attachCancellations(
      (id) => void inMemoryCancellations.request({ kind: "scorecard", id }, new Date().toISOString()).catch(() => {}),
    );
    // …and the same pair for the STANDALONE run lane (arch-review 52, Wave 3): one protocol, two kinds of
    // target, so a dev/test deployment exercises the run cancel's durable row exactly as production does.
    inMemoryRuns.attachCancellations(
      (id) => void inMemoryCancellations.request({ kind: "run", id }, new Date().toISOString()).catch(() => {}),
    );
    return {
      store: inMemoryRuns,
      scoringStageStore: new InMemoryScoringStageStore(),
      recordingStore: new InMemoryRecordingStore(),
      caseReceiptStore: inMemoryReceipts,
      // …and the reservation's PARENT AUTHORITY (arch-review 55, Wave 1): a dispatch may authorize external
      // work only while the batch or run it belongs to is still open and still owned at the epoch the attempt
      // was opened under. The Pg twin asks the same question as a correlated EXISTS inside its one UPDATE;
      // here the two stores are in the same process, so the reader closes over them.
      executionAttemptStore: new InMemoryExecutionAttemptStore(
        undefined,
        // …and the reservation's PARENT AUTHORITY (arch-review 55, Wave 1). The predicate itself is
        // `attemptParentAuthority` (arch-review 56, Wave A): it used to be a closure right here that
        // hand-wrote its own status vocabulary, which is how this lane came to permit a CANCELLED batch's
        // dispatch exactly like the SQL twin did.
        attemptParentAuthority({ scorecards: inMemoryScorecards, runs: inMemoryRuns }),
      ),
      cancellationStore: inMemoryCancellations,
      publicationOperationStore: inMemoryPublications,
      scorecardStore: inMemoryScorecards,
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
      handoffCheckpointStore: new InMemoryHandoffCheckpointStore(),
      verificationDecisionStore: new InMemoryVerificationDecisionStore(),
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
      productStore: inMemoryProducts,
      releaseStore: inMemoryReleases,
      productVersionStore: inMemoryProductVersions,
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
      replicas: soloReplicas,
    };
  }
  const client = sqlClient(makePool(url));
  const { applied } = await migrate(client);
  if (applied.length > 0) console.error(`▶ db migrations applied: ${applied.join(", ")}`);
  const harnessTemplateRegistry = new PgHarnessTemplateRegistry(client);
  return {
    store: new PgRunStore(client, REPLICA_ID),
    scoringStageStore: new PgScoringStageStore(client),
    recordingStore: new PgRecordingStore(client),
    caseReceiptStore: new PgCaseReceiptStore(client),
    executionAttemptStore: new PgExecutionAttemptStore(client),
    cancellationStore: new PgCancellationStore(client),
    publicationOperationStore: new PgPublicationOperationStore(client),
    scorecardStore: new PgScorecardStore(client, REPLICA_ID),
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
    handoffCheckpointStore: new PgHandoffCheckpointStore(client),
    verificationDecisionStore: new PgVerificationDecisionStore(client),
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
    productStore: new PgProductStore(client),
    releaseStore: new PgReleaseStore(client),
    // The resolution generations a ship's commit conditions on (mig 0163) — see PgCapabilityGenerationStore.
    capabilityGenerationStore: new PgCapabilityGenerationStore(client),
    constitutionApprovalStore: new PgConstitutionApprovalStore(client),
    // …and the PUBLISHER that writes a receipt and its dataset in one commit (arch-review 25 P0-2). Only this
    // layer can see one connection underneath two adapters, which is why cross-adapter atomicity lives here.
    constitutionalPublisher: pgConstitutionalPublisher(client),
    productVersionStore: new PgProductVersionStore(client),
    browserProfileStore: new PgBrowserProfileStore(client),
    skillStore: new PgSkillStore(client),
    skillVersionStore: new PgSkillVersionStore(client),
    capabilityStore: new PgCapabilityStore(client),
    agentMemberPreferenceStore: new PgAgentMemberPreferenceStore(client),
    callbackStore: new PgCallbackStore(client),
    usageStore: new PgUsageStore(client),
    budgetStore: new PgBudgetStore(client),
    leader: new PgLeaderElector(client, { role: CONTROL_PLANE_ROLE, holder: REPLICA_ID }),
    replicas: new PgReplicaRegistry(client, { replicaId: REPLICA_ID }),
    cipher,
  };
}
