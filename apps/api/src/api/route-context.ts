import { randomUUID, timingSafeEqual } from "node:crypto";
import { VersionTagsBodySchema, setVersionTags } from "@everdict/application-control";
import type { WorkflowStateService } from "@everdict/application-control";
import type { ApprovalService } from "@everdict/application-control";
import type { SandboxSessionService } from "@everdict/application-control";
import type { TrajectoryStore } from "@everdict/application-control";
import { type CiLinkService, UpsertCiLinkBodySchema } from "@everdict/application-control";
import { COMMENT_RESOURCE_TYPES, type CommentService } from "@everdict/application-control";
import type { PlatformEventService } from "@everdict/application-control";
import type { KnowledgeEntryService, KnowledgeService } from "@everdict/application-control";
import { deleteDatasetVersion } from "@everdict/application-control";
import type { GithubAppService } from "@everdict/application-control";
import { RepinBodySchema, repinHarnessImages } from "@everdict/application-control";
import { deleteHarnessVersion, harnessIsPrivate, harnessVisibleTo } from "@everdict/application-control";
import type { EnvironmentAdoptionService, ImageRegistryService, WorkspaceImages } from "@everdict/application-control";
import type { ProxyService } from "@everdict/application-control";
import type { MattermostCommandService } from "@everdict/application-control";
import type { MattermostService } from "@everdict/application-control";
import type { MembershipService } from "@everdict/application-control";
import type { NotificationService } from "@everdict/application-control";
import type { ProfileService } from "@everdict/application-control";
import type { QueueService } from "@everdict/application-control";
import type { RunService } from "@everdict/application-control";
import { installGithubWorkspaceRunner } from "@everdict/application-control";
import type { RunnerHubLike } from "@everdict/application-control";
import { PairRunnerBodySchema, RUNNER_CAPABILITIES, type RunnerService } from "@everdict/application-control";
import { type ScheduleService, isValidCron } from "@everdict/application-control";
import type { SpanAttrMappingService } from "@everdict/application-control";
import {
  IngestScorecardBodySchema,
  PullIngestBodySchema,
  type ScorecardService,
  originSource,
} from "@everdict/application-control";
import type { TraceSourceService } from "@everdict/application-control";
import type {
  CheckpointService,
  CycleService,
  GithubIssueSync,
  InitiativeService,
  IssueLabelService,
  IssueService,
  ProjectService,
  SubscriptionService,
  TaskService,
  TeamService,
  ViewService,
  ViewSnapshotService,
} from "@everdict/application-control";
import type { BrowserProfileService } from "@everdict/application-control";
import type { SkillService } from "@everdict/application-control";
import type { FileExecutionService, FsService } from "@everdict/application-control";
import type { CapabilityService } from "@everdict/application-control";
import type { WorkspaceService } from "@everdict/application-control";
import {
  API_KEY_SCOPES,
  type Action,
  type Authenticator,
  EVERDICT_ROLES,
  type Principal,
  type ResourceScope,
  authorize,
  can,
} from "@everdict/auth";
import {
  AppError,
  DatasetSchema,
  EvalCaseSchema,
  HarnessInstanceSpecSchema,
  HarnessTemplateSpecSchema,
  type ImageWarning,
  JudgeRunConfigSchema,
  JudgeSpecSchema,
  ModelSpecSchema,
  type RunRecord,
  type RuntimeSpec,
  RuntimeSpecSchema,
  resolveHarnessInstance,
} from "@everdict/contracts";
import type { InspectRuntimeResult, RuntimeControlCommand, RuntimeControlResult } from "@everdict/contracts/wire";
import {
  BenchmarkAdapterSpecSchema,
  HarborTaskSchema,
  TerminalBenchTaskSchema,
  diffDatasets,
  harborToDataset,
  terminalBenchToDataset,
} from "@everdict/datasets";
import {
  type SecretStore,
  type TenantKeyStore,
  type WorkspaceSettingsStore,
  type WorkspaceStore,
  issueKey,
} from "@everdict/db";
import { canReadRun, collectHarnessImages, imageWarnings } from "@everdict/domain";
import type { UsageMeter } from "@everdict/domain";
import type { ImageTokenService } from "@everdict/images";
import type {
  AgentRegistry,
  DatasetRegistry,
  HarnessInstanceRegistry,
  HarnessTemplateRegistry,
  JudgeRegistry,
  ModelRegistry,
  RubricRegistry,
  RuntimeRegistry,
} from "@everdict/registry";
import type { CallbackSink } from "@everdict/topology";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { WebSocketServer } from "ws";
import type { z } from "zod";
import { type BudgetAdmin, BudgetLimitInputSchema } from "../common/budget-tracker.js";
import type { CaseFsRequestHub } from "../common/case-fs-request-hub.js";
import type { CaseRecorder } from "../common/case-recorder.js";
import type { LiveFrameStore } from "../common/live-frame-store.js";
import type { LiveLogStore } from "../common/live-log-store.js";
import type { LiveTraceStore } from "../common/live-trace-store.js";
import type { TerminalTicketStore } from "../common/terminal-ticket.js";
import type { TicketStore } from "../common/ticket-store.js";
import type { AgentMemberToolingService } from "../core/agent/agent-member-tooling-service.js";
import type { AgentService } from "../core/agent/agent-service.js";
import {
  BenchmarkImportBodySchema,
  BenchmarkPreviewBodySchema,
  type BenchmarkService,
} from "../core/benchmark/benchmark-service.js";
import type { BrowserProfileCaptureService } from "../core/browser-profile/browser-profile-capture-service.js";
import type { BrowserSessionService } from "../core/browser-session/browser-session-service.js";
import { BundleSchema, type BundleService, requiredActionsForBundle } from "../core/bundle/bundle-service.js";
import type { ImageMirrorService } from "../core/image/image-mirror-service.js";
import type { JudgePreviewService } from "../core/judge/judge-preview-service.js";
import type { KnowledgeExtractionService } from "../core/knowledge/knowledge-extraction-service.js";
import type { ModelService } from "../core/model/model-service.js";
import type { OtlpIngestService } from "../core/observability/otlp-ingest-service.js";
import type { DriverOpsService } from "../core/ops/driver-ops-service.js";
import type { RuntimeProbeResult } from "../core/ops/runtime-probe.js";
import type { SecretUsageService } from "../core/secret/secret-usage-service.js";
import type { SkillGenerator } from "../core/skill/skill-generator.js";
import type { WorkspacePulseService } from "../core/workspace/workspace-pulse-service.js";
import type { McpProbeAuth, McpProbeResult } from "../infrastructure/mcp/probe-mcp.js";
import { buildMcpServer } from "../mcp.js";

export interface ServerDeps {
  service: RunService;
  scorecardService?: ScorecardService; // dataset×harness batch eval (route disabled if absent)
  // Driver ops surface v0 (docs/orchestration.md) — read/control the durable Temporal driver by ledger id.
  // Absent when no Temporal address is configured (routes answer 404 "not configured").
  driverOps?: DriverOpsService;
  // Durable agent approvals (agent-automation A6) — members list/decide; the agent service parks/settles.
  approvalService?: ApprovalService;
  // The OTLP/HTTP door (native-observability N0) — external/own traces seal in the owned TrajectoryStore.
  otlpIngest?: OtlpIngestService;
  usageMeter?: UsageMeter; // meter-only billing usage (GET /usage) — never blocks (route disabled if absent)
  budget?: BudgetAdmin; // enforcement budget config (GET/PUT /budget) — usage + per-tenant limit (route disabled if absent)
  // Settle-only capability of the enforcement budget for the internal usage bridge (agent cost → the 402-cap total).
  // Deliberately narrow (BudgetAdmin withholds settle from user routes; the Scheduler/services own the run settle).
  settleBudget?: (tenant: string, cost: { usd: number; tokens: number }) => void;
  // Admit-only capability for agent ACTIVATIONS (§5.1 — an activation answers the same gate questions as an
  // eval run before it exists): throws 402 past the tenant budget, reserves one run on pass.
  admitActivation?: (tenant: string) => void;
  scheduleService?: ScheduleService; // scheduled (cron) scorecard CRUD (route disabled if absent)
  queueService?: QueueService; // work-queue snapshot (running/waiting/next-scheduled per runtime lane) (route disabled if absent)
  metrics?: { render(): string }; // Prometheus text exposition (GET /metrics) (route disabled if absent)
  subscriptionService?: SubscriptionService; // subscription registry (event → reaction rules, E3) (route disabled if absent)
  viewService?: ViewService; // saved scorecard-analysis View CRUD (route disabled if absent)
  checkpointService?: CheckpointService; // handoff checkpoints (ownership O6) — publish/read (routes disabled if absent)
  taskService?: TaskService; // workspace task ledger — cross-agent coordination (route disabled if absent)
  // The eval tracker (docs/tracker.md) — the "why we evaluate" layer over the primitives (routes disabled if absent).
  teamService?: TeamService; // teams own issues and name them (ENG-12); a workspace always keeps one default
  cycleService?: CycleService;
  workflowStateService?: WorkflowStateService;
  issueService?: IssueService;
  // The workspace label registry an issue's labelIds point at (docs/tracker.md).
  issueLabelService?: IssueLabelService;
  projectService?: ProjectService;
  initiativeService?: InitiativeService;
  issueSync?: GithubIssueSync; // GitHub import + manual two-way sync (absent = no workspace GitHub App)
  viewSnapshotService?: ViewSnapshotService; // capture a View onto the workspace filesystem (route disabled if absent)
  benchmarkService?: BenchmarkService; // benchmark catalog + ingest (route disabled if absent)
  bundleService?: BundleService; // bundle apply (one-shot register of harness+benchmark+runtime; route disabled if absent)
  harnessTemplates?: HarnessTemplateRegistry; // harness category (template structure) CRUD
  harnessInstances?: HarnessInstanceRegistry; // individual harness (template+pins) CRUD + resolve

  datasetRegistry?: DatasetRegistry; // dataset CRUD (route disabled if absent)
  judgeRegistry?: JudgeRegistry; // Agent Judge CRUD (route disabled if absent)
  judgePreviewService?: JudgePreviewService; // zero-cost judge preview + one-case dry-run (route disabled if absent)
  rubricRegistry?: RubricRegistry; // Rubric (HOW to judge — referenced by judges) CRUD (route disabled if absent)
  modelRegistry?: ModelRegistry; // Model (inference/judging model) CRUD (route disabled if absent)
  modelService?: ModelService; // Model connection test (dummy completion) + version-free save/edit upsert (routes disabled if absent)
  agentRegistry?: AgentRegistry; // Agent config (instructions + MCP tool servers + model) CRUD — the workspace's conversational agent (route disabled if absent)
  agentService?: AgentService; // Agent version-free save/edit upsert (routes disabled if absent)
  // The CALLER's own agent (Settings › Agent › Tools + › Skills) — the workspace baseline overlaid with that
  // member's on/off, so two members of one workspace get two different agents (routes disabled if absent).
  agentMemberToolingService?: AgentMemberToolingService;
  skillService?: SkillService; // Workspace Skills (SKILL.md procedures the members author) CRUD (routes disabled if absent)
  fsService?: FsService; // the workspace filesystem (shared, workspace-isolated file tree) list/read/write/mkdir/move/remove (routes disabled if absent)
  // Run ONE workspace file in a sandbox (the viewer's "Run" — not an eval). Composed only where an execution
  // driver exists (EVERDICT_FILE_EXECUTION_DRIVER); absent = the route and the run_file tool do not exist, since
  // running user code on the control-plane process is not an acceptable fallback.
  fileExecutionService?: FileExecutionService;
  capabilityService?: CapabilityService; // Capability Store (mcp|code|skill authored + published + adopted) CRUD (routes disabled if absent)
  allowMemberPublicPublish?: boolean; // instance policy surfaced to the web via GET /me (config): members may publish `public`, not only admins
  // MCP probe — connect to an MCP URL and list its tools. Two callers: the capability wizard's "test connection"
  // (a pasted `token`) and Settings › Agent › Tools' function discovery (a resolved `authorization` header). Injected
  // by main (infrastructure/mcp). Route disabled if absent.
  probeCapabilityMcp?: (url: string, auth?: McpProbeAuth) => Promise<McpProbeResult>;

  skillGenerator?: SkillGenerator; // skill-generate — draft a skill from a description via the workspace's model (route disabled if absent)
  runtimeRegistry?: RuntimeRegistry; // Runtime (execution infra) CRUD (route disabled if absent)
  // Runtime connection test — RuntimeSpec → build a live backend, then probe() (reachability/auth without a job). main injects it with secrets + a builder.
  probeRuntime?: (workspace: string, spec: RuntimeSpec) => Promise<RuntimeProbeResult>;
  // Runtime live inspection — RuntimeSpec → build a live backend, then inspect() (read-only cluster view: nodes/capacity/workload/stores). Same secrets+builder as probe.
  inspectRuntime?: (workspace: string, spec: RuntimeSpec) => Promise<InspectRuntimeResult>;
  // Runtime destructive control — RuntimeSpec + command → build a live backend, run a Reclaimable action (stop/reclaim/purge/cordon). Gated runtimes:control.
  controlRuntime?: (
    workspace: string,
    spec: RuntimeSpec,
    command: RuntimeControlCommand,
  ) => Promise<RuntimeControlResult>;
  secretStore?: SecretStore; // workspace secret management — main always injects it (ON by default; auto-generates an ephemeral key if no KEK). Disabled only when not injected
  secretUsageService?: SecretUsageService; // reverse index: which registry specs / settings integrations reference each workspace secret (GET /secrets/usage) (route disabled if absent)
  invalidateTenantBackends?: (tenant: string) => void; // drop the tenant's cached runtime backends after a WORKSPACE secret change (their secretEnv is baked at build)
  githubAppService?: GithubAppService; // workspace-owned GitHub App integration (org install→selected repos) (route disabled if absent)
  mattermostService?: MattermostService; // workspace-owned Mattermost integration (register→bot notifications) (route disabled if absent)
  mattermostCommandService?: MattermostCommandService; // Mattermost inbound (slash commands/buttons) (route disabled if absent)
  traceSourceService?: TraceSourceService; // workspace trace sources (register + pull/export selection + browse) (route disabled if absent)
  spanAttrMappingService?: SpanAttrMappingService; // per-harness span-attr mapping overlay (the conversion layer between a harness and a judge) (route disabled if absent)
  imageRegistryService?: ImageRegistryService; // workspace image registries (classification baseline + push mint) (route disabled if absent)
  // Managed image store's authorization server — absent when no signing key/endpoint is configured, which is
  // exactly the "BYO only" deployment (the /v2/token route then 404s instead of pretending a registry exists).
  imageTokenService?: ImageTokenService;
  // The store itself (same on/off switch) — push-grant minting + manifest reads for the workspace's namespace.
  images?: WorkspaceImages;
  // Copy an image the deployment does not own INTO the managed registry (a workspace's namespace, or the
  // platform's through the internal path). Present wherever the managed store is.
  imageMirror?: ImageMirrorService;
  environmentAdoptionService?: EnvironmentAdoptionService; // workspace environment-image adoption inventory + pull verify (route disabled if absent)
  ciLinkService?: CiLinkService; // CI repo links (repo↔harness slot + OIDC trust) + picker/setup-PR (route disabled if absent)
  runnerService?: RunnerService; // self-hosted runners (personal device pairing) (route disabled if absent)
  notificationService?: NotificationService; // personal notification feed (bell inbox) — self-scoped (route disabled if absent)
  platformEvents?: PlatformEventService; // platform-event log (agent-automation A1) — internal reconcile cursor (route disabled if absent)
  commentService?: CommentService; // resource comments (datasets, etc.) — collaborative discussion (route disabled if absent)
  knowledgeService?: KnowledgeService; // workspace knowledge graph — node/related/subgraph queries + reindex (route disabled if absent)
  knowledgeEntryService?: KnowledgeEntryService; // knowledge entries (reified claims) CRUD + verify (routes disabled if absent)
  knowledgeExtraction?: KnowledgeExtractionService; // thread → proposed-entry mining (route disabled if absent)
  runnerHub?: RunnerHubLike; // self-hosted runner lease hub — used by the MCP lease/result/heartbeat tools (disabled if absent)
  settingsStore?: WorkspaceSettingsStore; // workspace settings (metering policy, etc.) (route disabled if absent)
  workspaceStore?: WorkspaceStore; // workspace membership — active-workspace resolution/bootstrap (single-workspace behavior if absent)
  workspaceService?: WorkspaceService; // workspace self-serve list/create (/workspaces route disabled if absent)
  workspacePulseService?: WorkspacePulseService; // the home screen's one read: workspace state + trend (route disabled if absent)
  membershipService?: MembershipService; // member management (list/role/remove/leave) + invites (issue/accept) (route disabled if absent)
  profileService?: ProfileService; // user profile (name/username/avatar) read·update (/me.profile + PATCH /me/profile disabled if absent)
  authenticator?: Authenticator; // authentication owned by the control plane (OIDC + API keys)
  keyStore?: TenantKeyStore; // for /internal/tenant-keys issuance
  internalToken?: string; // /internal/** guard (fail-closed if absent)
  metricsToken?: string; // GET /metrics operator-scrape guard (fail-closed if absent — the exposition carries per-workspace labels)
  // T-d bridge: the reaction workflow's activities reach the agent service THROUGH the CP (one bridge, the
  // reaper/approval discipline). Mirrors the agent service's HTTP answer so retry semantics ride honestly.
  reactionBridge?: {
    start(input: {
      workspace: string;
      agentId: string;
      eventId: string;
      subscriptionId: string;
      eventKind: string;
      message: string;
      payload?: Record<string, unknown>;
      subject?: { type: string; id: string };
      instruction?: string;
    }): Promise<{ status: number; body: unknown }>;
    status(workspace: string, sessionId: string): Promise<{ status: number; body: unknown }>;
  };
  // Runtime fairness dials (operator plane) — read/patch per-tenant quota/weight overrides without a restart.
  schedulingControl?: {
    effective(): { quotas: Record<string, number>; weights: Record<string, number> };
    set(patch: { quotas?: Record<string, number | null>; weights?: Record<string, number | null> }): void;
  };
  requireAuth?: boolean; // if true, auth is required (no dev fallback)
  devTenantHeader?: string; // unauthenticated dev-fallback header (default x-everdict-tenant)
  authorizationServers?: string[]; // MCP OAuth: authorization servers in the protected-resource metadata (Keycloak issuer)
  logLevel?: string; // pino log level (info/debug/warn/…). Absent = logging disabled (silent tests). main injects it via EVERDICT_LOG_LEVEL.
  callbackSink?: CallbackSink; // inbound receiver for the front-door callback completion model (/frontdoor-callback disabled if absent)
  // Interactive takeover of a run's browser (observability ⑦b) — same ticket primitive as the terminal, separate
  // store so a terminal ticket can never be replayed as a takeover.
  screenTickets?: TerminalTicketStore;
  terminalTickets?: TerminalTicketStore; // WS terminal (observability ⑥) — mints/consumes short-lived tickets (WS routes disabled if absent)
  liveFrames?: LiveFrameStore; // live-screen frames pushed by a self-hosted runner (report_case_screen) — served by RunService.screen()
  liveLogs?: LiveLogStore; // live execution log pushed by a self-hosted runner (report_case_log) — served by RunService.logs()
  liveTraces?: LiveTraceStore; // live trajectory per run (runner report_case_trace + dispatch marks) — served by RunService.liveTrace()
  caseRecorder?: CaseRecorder; // durable replay tee — persists the pushed frames/logs (docs/architecture/replay.md)
  caseFsRequests?: CaseFsRequestHub; // run-workbench fs rendezvous (self-hosted lane) — parked reads the runner's in-case loop answers
  browserSessionService?: BrowserSessionService; // interactive browser sessions (browser-profiles S1) — self-scoped (routes disabled if absent)
  sandboxSessions?: SandboxSessionService; // sandbox session runs (execution-model P6) — absent = no container runtime here
  trajectoryStore?: TrajectoryStore; // the owned evidence ledger's browse surface (N1 look-inward)
  traceIngestionConfig?: { defaultMaxEventsPerHour?: number; retentionDays?: number }; // N3 operator defaults (display)
  browserTickets?: TicketStore; // WS ticket store for interactive browser sessions (browser-session WS disabled if absent)
  browserProfileService?: BrowserProfileService; // saved authenticated browser profiles (browser-profiles S2) — workspace-scoped (routes disabled if absent)
  browserProfileCaptureService?: BrowserProfileCaptureService; // capture a session login into a profile (browser-profiles S3) — needs browser sessions (route disabled if absent)
  proxyService?: ProxyService; // workspace BYO egress proxies (browser-profiles S4) — per-country pool for the login browser (route disabled if absent)
}

// Resolve identity (subject + default workspace + roles): Bearer (JWT or ak_) → Authenticator. Unauthenticated dev = header workspace + admin.
export async function resolveIdentity(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: ServerDeps,
): Promise<Principal | undefined> {
  const authz = req.headers.authorization;
  if (deps.authenticator && typeof authz === "string" && authz.startsWith("Bearer ")) {
    // workspaceHint (x-everdict-workspace) — used by GitHub Actions federation to match against that workspace's repo links.
    const principal = await deps.authenticator.authenticate(authz.slice(7).trim(), {
      workspaceHint: workspaceHintOf(req),
    });
    if (!principal) {
      // Verification failed — for the specific reason (issuer mismatch/JWKS unreachable/expired/signature/non-JWT) see the 'auth: OIDC token verification failed' log.
      req.log.warn({ path: req.url }, "auth: Bearer credential rejected → 401");
      reply.code(401).send({ code: "UNAUTHENTICATED", message: "Invalid credentials." });
      return undefined;
    }
    req.log.debug(
      { subject: principal.subject, workspace: principal.workspace, via: principal.via },
      "auth: authenticated",
    );
    return principal;
  }
  if (deps.requireAuth) {
    req.log.warn(
      { path: req.url, hasAuthHeader: typeof authz === "string" },
      "auth: no credential (requireAuth) → 401",
    );
    reply.code(401).send({ code: "UNAUTHENTICATED", message: "Authorization: Bearer <token|api-key> is required." });
    return undefined;
  }
  // dev fallback: header workspace, full permissions.
  const header = (req.headers as Record<string, unknown>)[deps.devTenantHeader ?? "x-everdict-tenant"];
  const workspace = typeof header === "string" && header.length > 0 ? header : "default";
  req.log.debug({ workspace }, "auth: dev fallback (x-everdict-tenant) — requireAuth unset");
  return { subject: "dev", workspace, roles: ["admin"], via: "api-key" };
}

// Resolve the active workspace: if a membership store exists, bootstrap the token/dev default workspace into a membership,
// and if the subject is a member of the workspace named by the x-everdict-workspace header, switch to it (roles are also reinterpreted as the membership role).
// A request for a non-member workspace falls back to the default workspace rather than 403 (isolation-safe even on a stale selection + robust UX).
// If base.workspace is empty (external Keycloak: no workspace claim) — switch to the member workspace the cookie points at,
// or leave workspace="" if there is none (no membership yet → /me.workspaces=[] → web onboarding). Not a 401.
// With no store, keep the original single-workspace behavior (backward compatible).
// The active-workspace header the request names (sent by the web cookie / CI workflow). Absent → undefined.
export function workspaceHintOf(req: FastifyRequest): string | undefined {
  const header = (req.headers as Record<string, unknown>)["x-everdict-workspace"];
  return typeof header === "string" && header.length > 0 ? header : undefined;
}

// The subject's TEAM MEMBERSHIPS in the resolved workspace — an authorization input, not decoration: a write
// against a resource owned by a team the subject is not on is refused by can() in @everdict/domain. Loaded here,
// beside the membership role, because both answer "what may this request do in THIS workspace" and both must come
// from the control plane rather than the client.
//
// A failure loads NO teams rather than throwing: the request then behaves as a subject on no team — it writes and
// reads the workspace's unowned rows and nothing owned. That is the right side to err on (a lookup we could not
// do must never widen access) and it never takes the whole request down, but since ownership now isolates READS
// too, the same failure also empties this caller's lists — so it is logged rather than swallowed, because
// "your team has nothing" and "we could not find out which teams are yours" look identical on screen.
async function withTeams(principal: Principal, deps: ServerDeps, req: FastifyRequest): Promise<Principal> {
  const service = deps.teamService;
  if (!service || !principal.workspace) return principal;
  const [teams, fallback] = await Promise.all([
    service.list(principal.workspace, { member: principal.subject }).catch((err) => {
      req.log.warn(
        { subject: principal.subject, workspace: principal.workspace, err },
        "auth: team roster lookup failed — the request proceeds as a subject on no team (owned resources are hidden)",
      );
      return [];
    }),
    // Every workspace MEMBER is on the default team whether or not anyone wrote them into its roster. The default
    // team is not a team someone chose to be on: it is where an unnamed asset lands and where the ownership
    // migration put everything that predates the axis, so isolating it would empty the screen of every member an
    // admin has not got around to rostering. Teams people actually created stay isolated, which is the point.
    service
      .defaultTeam(principal.workspace)
      .catch(() => undefined),
  ]);
  const ids = new Set(teams.map((team) => team.id));
  if (fallback) ids.add(fallback.id);
  return { ...principal, teams: [...ids] };
}

export async function applyActiveWorkspace(base: Principal, req: FastifyRequest, deps: ServerDeps): Promise<Principal> {
  // A runner token (via=runner) has a fixed workspace + minimal perms (roles:["runner"]) — exclude it from membership bootstrap / role promotion.
  // (Without the exclusion it would be promoted to the owner's membership role and the device credential would gain admin.)
  // GitHub Actions federation (via=github-actions) is the same — a workspace fixed by repo-link trust + the ci role, and it is not
  // a member (bootstrapping would give the CI repo a member row).
  if (base.via === "runner" || base.via === "github-actions") return base;
  const store = deps.workspaceStore;
  if (!store) return base;
  const subject = base.subject;

  // The OIDC name claim seeds the user profile (fill-if-absent — a self-set profile name wins), so member lists
  // and "created by" surfaces show the person's real name instead of the opaque sub. Best-effort: display
  // metadata must never fail authentication.
  if (base.name !== undefined && deps.profileService) {
    await deps.profileService.seedSsoName(subject, base.name).catch(() => {});
  }

  // If there's a token/dev default workspace, bootstrap it into a membership (only when one doesn't exist).
  // The email claim (if present) is captured/backfilled into the member row on every login — role is preserved (ensureMembership COALESCEs / leaves role unchanged).
  // ⚠️ Role is per-workspace: a new workspace (effectively the creator) or a machine key (issuance is admin-gated) uses the token role, but
  // when a human (OIDC) joins an existing workspace via bootstrap they are capped to member — a Keycloak realm role can't grant
  // admin on someone else's workspace (admin only via creation [POST /workspaces] · invite · promotion). If already a member, that membership role wins.
  let baseRole: string | undefined;
  if (base.workspace) {
    baseRole = await store.roleFor(base.workspace, subject);
    if (!baseRole) {
      const fresh = !(await store.get(base.workspace));
      baseRole = fresh || base.via === "api-key" ? (base.roles[0] ?? "member") : "member";
      await store.ensureMembership(base.workspace, subject, baseRole, base.email);
    } else if (base.email !== undefined) {
      await store.ensureMembership(base.workspace, subject, baseRole, base.email); // existing member — only refresh email
    }
  }

  // If the x-everdict-workspace header (the web's active-workspace cookie) points at a different workspace and the subject is a member, switch.
  const requested = workspaceHintOf(req) ?? base.workspace;
  if (requested && requested !== base.workspace) {
    const role = await store.roleFor(requested, subject);
    if (role) return withTeams({ ...base, workspace: requested, roles: [role] }, deps, req);
  }

  // Fall back to the default workspace (membership role if present). Otherwise keep workspace="" (onboarding target).
  return base.workspace ? withTeams({ ...base, roles: [baseRole as string] }, deps, req) : base;
}

// Final Principal with both authentication and active workspace resolved (used by every human/HTTP route).
export async function resolvePrincipal(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: ServerDeps,
): Promise<Principal | undefined> {
  const base = await resolveIdentity(req, reply, deps);
  if (!base) return undefined;
  return applyActiveWorkspace(base, req, deps);
}

export function constantTimeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// Zod issues → human-readable "path: message" list (for validation responses).
export function zodIssues(err: z.ZodError): string[] {
  return err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
}

// MCP-only Principal resolution: Bearer (JWT/ak_) only — no dev header fallback (unauthenticated → 401 + login challenge).
// Active-workspace / membership bootstrap applies the same way (so list_workspaces etc. behave consistently).
export async function resolveBearerPrincipal(req: FastifyRequest, deps: ServerDeps): Promise<Principal | undefined> {
  const authz = req.headers.authorization;
  if (deps.authenticator && typeof authz === "string" && authz.startsWith("Bearer ")) {
    const base = await deps.authenticator.authenticate(authz.slice(7).trim(), { workspaceHint: workspaceHintOf(req) });
    if (!base) {
      req.log.warn({ path: req.url }, "auth(mcp): Bearer credential rejected → 401 challenge");
      return undefined;
    }
    return applyActiveWorkspace(base, req, deps);
  }
  req.log.warn({ path: req.url, hasAuthHeader: typeof authz === "string" }, "auth(mcp): no Bearer → 401 challenge");
  return undefined;
}

export function baseUrl(req: FastifyRequest): string {
  const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? req.protocol;
  return `${proto}://${req.headers.host}`;
}

// RFC 9728 — point MCP clients at the authorization server so they start an OAuth login (like the Linear MCP).
export function protectedResourceMetadata(req: FastifyRequest, deps: ServerDeps): Record<string, unknown> {
  const base = baseUrl(req);
  return {
    resource: `${base}/mcp`,
    authorization_servers: deps.authorizationServers ?? [],
    bearer_methods_supported: ["header"],
    scopes_supported: ["openid", "profile"],
    resource_name: "Everdict MCP",
  };
}

// Unauthenticated → 401 + WWW-Authenticate (resource_metadata). The client uses this to start OAuth discovery/login.
export function mcpChallenge(req: FastifyRequest, reply: FastifyReply): FastifyReply {
  const metaUrl = `${baseUrl(req)}/.well-known/oauth-protected-resource`;
  return reply
    .code(401)
    .header("WWW-Authenticate", `Bearer resource_metadata="${metaUrl}"`)
    .send({ code: "UNAUTHENTICATED", message: "MCP requires OAuth authentication (see resource_metadata)." });
}

// Team OWNERSHIP resolution + the read guard live in `common/team-scope.ts` (both transports need them, and
// an MCP tool file cannot import this module without closing a cycle): teamOfVersion / teamOfEntity /
// assertEntityVisible / assertTeamVisible / visibleTeamsFor / teamCeiling.

// Re-exported so a ROUTE keeps one import surface (this module, beside gate/sendError) while an MCP tool file
// imports the same functions straight from `common/team-scope.js` — it cannot import this one without a cycle.
export { resolveTeamRef, teamForNew } from "../common/team-scope.js";

// authorize wrapper — throws ForbiddenError as-is so sendError maps it to 403.
// `resource` carries the OWNING TEAM when the target has one: a write against another team's harness/dataset/…
// is refused even though the role allows the action in general. Omit it for workspace-level actions; for READS
// use `assertTeamVisible` below instead, which answers the same refusal as 404.
export function gate(principal: Principal, action: Action, resource?: ResourceScope): void {
  authorize(principal, action, resource);
}

// Is this run THIS caller's to read? Workspace scoping and the audience rule in one question, because the two
// have the same answer (404, no existence leak): a foreign workspace's run and another member's personal
// execution — an agent turn, a sandbox shell (`runAudience`, @everdict/domain) — are equally none of the
// caller's business. Used by the run observability routes, which hold the record already; the data reads
// (get/list/trajectory) apply the same rule inside RunService so both transports inherit it.
export function runVisible(
  record: Pick<RunRecord, "tenant" | "kind" | "createdBy" | "origin">,
  principal: Principal,
): boolean {
  return record.tenant === principal.workspace && canReadRun(record, principal.subject);
}

// The READ half of the team axis lives in `common/team-scope.ts` (both transports need it, and the MCP tool files
// cannot import this module without closing a cycle): `assertTeamVisible` / `visibleTeamsFor` / `teamCeiling`.

// AppError → flat error response; anything else → 500. Every route funnels failures through this.
export function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof AppError) return reply.code(err.status).send(err.toEnvelope());
  return reply.code(500).send({ code: "INTERNAL", message: err instanceof Error ? err.message : String(err) });
}
