import type { CiLinkService } from "@everdict/application-control";
import type { WorkflowStateService } from "@everdict/application-control";
import type { SandboxSessionService } from "@everdict/application-control";
import type { TrajectoryStore } from "@everdict/application-control";
import type { ApprovalService } from "@everdict/application-control";
import type { PlatformEventService } from "@everdict/application-control";
import type { CommentService } from "@everdict/application-control";
import type { KnowledgeEntryService, KnowledgeService } from "@everdict/application-control";
import type { GithubAppService } from "@everdict/application-control";
import type { EnvironmentAdoptionService, ImageRegistryService, WorkspaceImages } from "@everdict/application-control";
import type { ProxyService } from "@everdict/application-control";
import type { CapabilityService } from "@everdict/application-control";
import type { MattermostService } from "@everdict/application-control";
import type { MembershipService } from "@everdict/application-control";
import type { NotificationService } from "@everdict/application-control";
import type { ProfileService } from "@everdict/application-control";
import type { QueueService } from "@everdict/application-control";
import type { RunService } from "@everdict/application-control";
import type { RunnerHubLike } from "@everdict/application-control";
import type { RunnerService } from "@everdict/application-control";
import type { ScheduleService } from "@everdict/application-control";
import type { ScorecardService } from "@everdict/application-control";
import type { SkillService } from "@everdict/application-control";
import type { FileExecutionService, FsService } from "@everdict/application-control";
import type { SpanAttrMappingService } from "@everdict/application-control";
import type { TraceSourceService } from "@everdict/application-control";
import type {
  CheckpointService,
  CycleService,
  GithubIssueSync,
  InitiativeService,
  IssueLabelService,
  IssueService,
  ProductService,
  ProductVersionSync,
  ProjectService,
  SubscriptionService,
  TaskService,
  TeamService,
  ViewService,
  ViewSnapshotService,
} from "@everdict/application-control";
import type { BrowserProfileService } from "@everdict/application-control";
import type { WorkspaceService } from "@everdict/application-control";
import { type Action, type Principal, type ResourceScope, authorize } from "@everdict/auth";
import { AppError, type RuntimeSpec } from "@everdict/contracts";
import type { InspectRuntimeResult, RuntimeControlCommand, RuntimeControlResult } from "@everdict/contracts/wire";
import type { SecretStore, TenantKeyStore, WorkspaceSettingsStore } from "@everdict/db";
import type { UsageMeter } from "@everdict/domain";
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
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { BudgetAdmin } from "../common/budget-tracker.js";
import type { CaseFsRequestHub } from "../common/case-fs-request-hub.js";
import type { CaseRecorder } from "../common/case-recorder.js";
import type { LiveFrameStore } from "../common/live-frame-store.js";
import type { LiveLogStore } from "../common/live-log-store.js";
import type { LiveTraceStore } from "../common/live-trace-store.js";
import { teamForNew } from "../common/team-scope.js";
import type { TicketStore } from "../common/ticket-store.js";
import type { AgentMemberToolingService } from "../core/agent/agent-member-tooling-service.js";
import type { AgentService } from "../core/agent/agent-service.js";
import type { BenchmarkService } from "../core/benchmark/benchmark-service.js";
import type { BrowserProfileCaptureService } from "../core/browser-profile/browser-profile-capture-service.js";
import type { BrowserSessionService } from "../core/browser-session/browser-session-service.js";
import type { BundleService } from "../core/bundle/bundle-service.js";
import type { ImageMirrorService } from "../core/image/image-mirror-service.js";
import type { JudgePreviewService } from "../core/judge/judge-preview-service.js";
import type { KnowledgeExtractionService } from "../core/knowledge/knowledge-extraction-service.js";
import type { ModelService } from "../core/model/model-service.js";
import type { DriverOpsService } from "../core/ops/driver-ops-service.js";
import type { RuntimeProbeResult } from "../core/ops/runtime-probe.js";
import type { SecretUsageService } from "../core/secret/secret-usage-service.js";
import type { WorkspacePulseService } from "../core/workspace/workspace-pulse-service.js";
import type { McpProbeAuth, McpProbeResult } from "../infrastructure/mcp/probe-mcp.js";
import type { AgentAttribution } from "./fs/fs-actor.js";

// MCP tool surface — the "agent transport" sharing the same service core as the HTTP routes.
// Each tool is authorized by the Principal's roles and scoped to workspace (the control plane is the auth/authz authority).
export interface McpDeps {
  service: RunService;
  cycleService?: CycleService;
  workflowStateService?: WorkflowStateService;
  scorecardService?: ScorecardService;
  driverOps?: DriverOpsService; // Driver ops surface v0 — describe/cancel the durable Temporal driver by ledger id
  approvalService?: ApprovalService; // durable agent approvals (A6) — list/decide
  usageMeter?: UsageMeter; // meter-only billing usage (get_usage)
  budget?: BudgetAdmin; // enforcement budget config (get_budget / set_budget_limit)
  scheduleService?: ScheduleService;
  queueService?: QueueService; // work queue snapshot (running/waiting/next-scheduled per runtime lane)
  subscriptionService?: SubscriptionService; // subscription registry (event → reaction rules, E3)
  viewService?: ViewService; // saved scorecard-analysis Views — create/list/get/update/delete
  checkpointService?: CheckpointService; // handoff checkpoints (ownership O6) — publish/list/get
  taskService?: TaskService; // workspace task ledger — cross-agent coordination
  // The eval tracker (docs/tracker.md) — an agent triages its own regressions through these.
  teamService?: TeamService;
  issueService?: IssueService;
  issueLabelService?: IssueLabelService;
  projectService?: ProjectService;
  initiativeService?: InitiativeService;
  productService?: ProductService; // the product timeline (docs/architecture/product-timeline.md)
  productVersionSync?: ProductVersionSync;
  issueSync?: GithubIssueSync; // GitHub import + manual two-way sync (absent = no workspace GitHub App)
  viewSnapshotService?: ViewSnapshotService; // capture_view_snapshot — write a View's numbers to the workspace filesystem
  harnessTemplates?: HarnessTemplateRegistry;
  harnessInstances?: HarnessInstanceRegistry;
  datasetRegistry?: DatasetRegistry;
  judgeRegistry?: JudgeRegistry;
  judgePreviewService?: JudgePreviewService; // zero-cost judge preview (preview_judge) + one-case dry-run
  rubricRegistry?: RubricRegistry; // Rubric (HOW to judge) register/read — judges reference it by {id, version}
  modelRegistry?: ModelRegistry; // Model (inference/judgment model) register/read — judge and command harnesses reference it by id
  modelService?: ModelService; // Model connection test (dummy completion) + version-free save/edit upsert
  agentRegistry?: AgentRegistry; // Agent config (instructions + MCP tool servers + model) register/read — the conversational agent per workspace
  agentService?: AgentService; // Agent version-free save/edit upsert
  agentMemberToolingService?: AgentMemberToolingService; // the caller's OWN tools + skills (workspace baseline ⊕ their overrides)
  skillService?: SkillService; // Workspace Skills (SKILL.md procedures the members author) CRUD — dual-scoped private|workspace
  fsService?: FsService; // the workspace filesystem (shared, workspace-isolated file tree) list/read/write/mkdir/move/remove
  fileExecutionService?: FileExecutionService; // run one workspace file in a sandbox (run_file) — absent unless a driver is composed
  capabilityService?: CapabilityService; // Capability Store (mcp|code|skill authored + published + adopted) CRUD
  probeCapabilityMcp?: (url: string, auth?: McpProbeAuth) => Promise<McpProbeResult>; // mcp "test connection" + tool discovery (wizard token / bound authorization)
  runtimeRegistry?: RuntimeRegistry;
  probeRuntime?: (workspace: string, spec: RuntimeSpec) => Promise<RuntimeProbeResult>; // runtime connection test
  inspectRuntime?: (workspace: string, spec: RuntimeSpec) => Promise<InspectRuntimeResult>; // runtime live cluster view
  controlRuntime?: (
    workspace: string,
    spec: RuntimeSpec,
    command: RuntimeControlCommand,
  ) => Promise<RuntimeControlResult>; // runtime destructive control (stop/reclaim/purge/cordon)
  secretStore?: SecretStore;
  secretUsageService?: SecretUsageService; // reverse index of workspace secret references (list_secret_usage)
  invalidateTenantBackends?: (tenant: string) => void; // workspace secret change → drop cached runtime backends (route parity)
  githubAppService?: GithubAppService; // workspace-owned GitHub App integration (org install → selected repos)
  mattermostService?: MattermostService; // workspace-owned Mattermost integration (register → bot notifications)
  traceSourceService?: TraceSourceService; // workspace trace sources (register + pull/export selection + list/inspect browser)
  spanAttrMappingService?: SpanAttrMappingService; // per-harness span-attr mapping overlay (the conversion layer between a harness and a judge)
  imageRegistryService?: ImageRegistryService; // workspace image registry (classification baseline + push publishing)
  images?: WorkspaceImages; // everdict's OWN managed image store — absent on a BYO-only deployment
  imageMirror?: ImageMirrorService; // copy an image INTO that store (mirror_image)
  environmentAdoptionService?: EnvironmentAdoptionService; // workspace environment-image adoption inventory + pull verify
  ciLinkService?: CiLinkService; // CI repo link (repo↔harness slot + OIDC trust) + picker/setup-PR
  runnerService?: RunnerService; // self-hosted runners (personal device pairing) — pair/list/revoke + workspace roster
  notificationService?: NotificationService; // personal notification feed (bell inbox) — list/read (self-scoped)
  platformEvents?: PlatformEventService; // platform-event log (lifecycle facts) — list (events:read)
  commentService?: CommentService; // resource comments (datasets, etc.) — list/create/delete
  knowledgeService?: KnowledgeService; // workspace knowledge graph — get_knowledge_node/knowledge_related/knowledge_subgraph/reindex_knowledge
  knowledgeEntryService?: KnowledgeEntryService; // knowledge entries (reified claims) — create/list/get/update/delete/verify_knowledge_entry
  knowledgeExtraction?: KnowledgeExtractionService; // extract_knowledge — thread → proposed entries
  runnerHub?: RunnerHubLike; // runner lease hub — lease_job/submit_job_result/fail_job/heartbeat_job (runner token only)
  liveFrames?: LiveFrameStore; // latest live-screen frame per run, pushed by a self-hosted runner (report_case_screen)
  liveLogs?: LiveLogStore; // accumulated live execution log per run, pushed by a self-hosted runner (report_case_log)
  liveTraces?: LiveTraceStore; // accumulated live trajectory per run — runner pushes (report_case_trace) + dispatch marks
  caseRecorder?: CaseRecorder; // durable replay tee — persists pushed frames/logs so a run can be replayed after it settles
  caseFsRequests?: CaseFsRequestHub; // run-workbench fs rendezvous (self-hosted lane) — parked reads the runner's in-case loop answers
  settingsStore?: WorkspaceSettingsStore;
  benchmarkService?: BenchmarkService; // benchmark preview + import (source → dataset)
  bundleService?: BundleService; // bundle one-shot apply (harness + benchmark + runtime, etc.)
  workspaceService?: WorkspaceService; // workspace self-serve list/create (no role gate — by subject)
  workspacePulseService?: WorkspacePulseService; // "how is this workspace doing" — state + trend in one read
  membershipService?: MembershipService; // member management (list/role/remove/leave) + invites (issue/accept)
  profileService?: ProfileService; // my profile (name/username/avatar) read/edit (self-serve)
  keyStore?: TenantKeyStore; // API key self-serve issue/list/revoke (admin)
  apiPublicUrl?: string; // control-plane public base — the everdict runner --api-url in github_install_workspace_runner (falls back to the request base)
  browserSessionService?: BrowserSessionService; // interactive browser sessions (browser-profiles S1) — self-scoped
  sandboxSessions?: SandboxSessionService; // sandbox session runs (execution-model P6) — absent = no container runtime here
  trajectoryStore?: TrajectoryStore; // the owned evidence ledger's browse surface (N1 look-inward)
  traceIngestionConfig?: { defaultMaxEventsPerHour?: number; retentionDays?: number }; // N3 operator defaults (display)
  browserTickets?: TicketStore; // WS ticket store for interactive browser sessions
  browserProfileService?: BrowserProfileService; // saved authenticated browser profiles (browser-profiles S2) — workspace-scoped
  browserProfileCaptureService?: BrowserProfileCaptureService; // capture a session login into a profile (browser-profiles S3)
  proxyService?: ProxyService; // workspace BYO egress proxies (browser-profiles S4) — per-country pool for the login browser
}

// The per-session context a resource's registerXTools(server, ctx) receives — the MCP twin of route-context.
export interface McpToolContext {
  deps: McpDeps;
  principal: Principal;
  ws: string; // principal.workspace
  // WHICH agent holds this session, when the client declared it at initialize (apps/agent does, per conversation).
  // The bearer already says which MEMBER — this says which agent ran on their behalf, so authorship of what the
  // session writes (workspace files today) names the agent and its conversation instead of just the member.
  agent?: AgentAttribution;
}

export function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
export function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

// An AppError as the agent sees it: the code + message, PLUS the error's structured data when it carries any.
// That payload is often the whole point of the failure — a filesystem write that lost a race returns the live
// content and an attempted merge, and without it the agent is told "CONFLICT" with no way to recover. The HTTP
// transport has always shipped it (`toEnvelope().data`); dropping it here made the two transports disagree.
function failFrom(err: AppError): CallToolResult {
  const head = `${err.code}: ${err.message}`;
  if (err.extra === undefined || Object.keys(err.extra).length === 0) return fail(head);
  return fail(`${head}\n${JSON.stringify(err.extra, null, 2)}`);
}

// authorize + AppError → isError conversion (so the agent recognizes it as a tool error / permission error).
export async function run(
  principal: Principal,
  action: Action,
  fn: () => Promise<CallToolResult>,
  resource?: ResourceScope,
): Promise<CallToolResult> {
  try {
    // `resource` carries the owning team when the tool targets one — the MCP twin of the routes' gate(), so an
    // agent cannot write another team's asset through a tool call that the HTTP route would have refused.
    authorize(principal, action, resource);
    return await fn();
  } catch (err) {
    if (err instanceof AppError) return failFrom(err);
    return fail(err instanceof Error ? err.message : String(err));
  }
}

// Create-with-an-owner, gated: resolve the team the caller named (id or key), authorize the action AGAINST it,
// then run. The MCP twin of a route's `teamForNew` + `gate(…, owner.gate)` pair, calling the same helper — an
// agent naming a team its creator is not on is refused here exactly as the HTTP route refuses it. `fn` receives
// the owner to stamp; undefined means "none named", which the service resolves by its own default rule.
export async function runForTeam(
  ctx: McpToolContext,
  action: Action,
  requested: string | undefined,
  fn: (teamId: string | undefined) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    // Resolved before the gate: comparing a KEY against the id list a principal carries would refuse a member of
    // the very team they named.
    const owner = await teamForNew(ctx.principal, ctx.deps, requested);
    return await run(ctx.principal, action, () => fn(owner.teamId), owner.gate);
  } catch (err) {
    if (err instanceof AppError) return failFrom(err);
    return fail(err instanceof Error ? err.message : String(err));
  }
}

// A team named by id or by key (`ENG`) → the id a store indexes by. The MCP twin of the routes' resolveTeamRef,
// so an agent may name a team the way a person does — and gets a 404-shaped failure for an unknown one instead
// of an empty list that reads as "this team has nothing".
export async function resolveTeam(ctx: McpToolContext, ref: string): Promise<string> {
  const teams = ctx.deps.teamService;
  return teams ? teams.resolveId(ctx.ws, ref) : ref;
}

// Tools with no role gate (workspace self-serve list/create). AppError → isError conversion only.
export async function plain(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError) return failFrom(err);
    return fail(err instanceof Error ? err.message : String(err));
  }
}
