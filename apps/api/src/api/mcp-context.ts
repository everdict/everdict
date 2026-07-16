import type { CiLinkService } from "@everdict/application-control";
import type { CommentService } from "@everdict/application-control";
import type { GithubAppService } from "@everdict/application-control";
import type { ImageRegistryService } from "@everdict/application-control";
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
import type { SpanAttrMappingService } from "@everdict/application-control";
import type { TraceSinkService } from "@everdict/application-control";
import type { TraceSourceService } from "@everdict/application-control";
import type { ViewService } from "@everdict/application-control";
import type { BrowserProfileService } from "@everdict/application-control";
import type { WorkspaceService } from "@everdict/application-control";
import { type Action, type Principal, authorize } from "@everdict/auth";
import { AppError, type RuntimeSpec } from "@everdict/contracts";
import type { InspectRuntimeResult, RuntimeControlCommand, RuntimeControlResult } from "@everdict/contracts/wire";
import type { SecretStore, TenantKeyStore, WorkspaceSettingsStore } from "@everdict/db";
import type { UsageMeter } from "@everdict/domain";
import type {
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
import type { LiveFrameStore } from "../common/live-frame-store.js";
import type { TicketStore } from "../common/ticket-store.js";
import type { BenchmarkService } from "../core/benchmark/benchmark-service.js";
import type { BrowserProfileCaptureService } from "../core/browser-profile/browser-profile-capture-service.js";
import type { BrowserSessionService } from "../core/browser-session/browser-session-service.js";
import type { BundleService } from "../core/bundle/bundle-service.js";
import type { JudgePreviewService } from "../core/judge/judge-preview-service.js";
import type { RuntimeProbeResult } from "../core/ops/runtime-probe.js";

// MCP tool surface — the "agent transport" sharing the same service core as the HTTP routes.
// Each tool is authorized by the Principal's roles and scoped to workspace (the control plane is the auth/authz authority).
export interface McpDeps {
  service: RunService;
  scorecardService?: ScorecardService;
  usageMeter?: UsageMeter; // meter-only billing usage (get_usage)
  budget?: BudgetAdmin; // enforcement budget config (get_budget / set_budget_limit)
  scheduleService?: ScheduleService;
  queueService?: QueueService; // work queue snapshot (running/waiting/next-scheduled per runtime lane)
  viewService?: ViewService; // saved scorecard-analysis Views — create/list/get/update/delete
  harnessTemplates?: HarnessTemplateRegistry;
  harnessInstances?: HarnessInstanceRegistry;
  datasetRegistry?: DatasetRegistry;
  judgeRegistry?: JudgeRegistry;
  judgePreviewService?: JudgePreviewService; // zero-cost judge preview (preview_judge) + one-case dry-run
  rubricRegistry?: RubricRegistry; // Rubric (HOW to judge) register/read — judges reference it by {id, version}
  modelRegistry?: ModelRegistry; // Model (inference/judgment model) register/read — judge and command harnesses reference it by id
  runtimeRegistry?: RuntimeRegistry;
  probeRuntime?: (workspace: string, spec: RuntimeSpec) => Promise<RuntimeProbeResult>; // runtime connection test
  inspectRuntime?: (workspace: string, spec: RuntimeSpec) => Promise<InspectRuntimeResult>; // runtime live cluster view
  controlRuntime?: (
    workspace: string,
    spec: RuntimeSpec,
    command: RuntimeControlCommand,
  ) => Promise<RuntimeControlResult>; // runtime destructive control (stop/reclaim/purge/cordon)
  secretStore?: SecretStore;
  invalidateTenantBackends?: (tenant: string) => void; // workspace secret change → drop cached runtime backends (route parity)
  githubAppService?: GithubAppService; // workspace-owned GitHub App integration (org install → selected repos)
  mattermostService?: MattermostService; // workspace-owned Mattermost integration (register → bot notifications)
  traceSinkService?: TraceSinkService; // workspace trace sinks (export to an observability platform)
  traceSourceService?: TraceSourceService; // workspace trace sources (pull from an observability platform) + list/inspect (observability browser)
  spanAttrMappingService?: SpanAttrMappingService; // per-harness span-attr mapping overlay (the conversion layer between a harness and a judge)
  imageRegistryService?: ImageRegistryService; // workspace image registry (classification baseline + push publishing)
  ciLinkService?: CiLinkService; // CI repo link (repo↔harness slot + OIDC trust) + picker/setup-PR
  runnerService?: RunnerService; // self-hosted runners (personal device pairing) — pair/list/revoke + workspace roster
  notificationService?: NotificationService; // personal notification feed (bell inbox) — list/read (self-scoped)
  commentService?: CommentService; // resource comments (datasets, etc.) — list/create/delete
  runnerHub?: RunnerHubLike; // runner lease hub — lease_job/submit_job_result/fail_job/heartbeat_job (runner token only)
  liveFrames?: LiveFrameStore; // latest live-screen frame per run, pushed by a self-hosted runner (report_case_screen)
  settingsStore?: WorkspaceSettingsStore;
  benchmarkService?: BenchmarkService; // benchmark preview + import (source → dataset)
  bundleService?: BundleService; // bundle one-shot apply (harness + benchmark + runtime, etc.)
  workspaceService?: WorkspaceService; // workspace self-serve list/create (no role gate — by subject)
  membershipService?: MembershipService; // member management (list/role/remove/leave) + invites (issue/accept)
  profileService?: ProfileService; // my profile (name/username/avatar) read/edit (self-serve)
  keyStore?: TenantKeyStore; // API key self-serve issue/list/revoke (admin)
  apiPublicUrl?: string; // control-plane public base — the everdict runner --api-url in github_install_workspace_runner (falls back to the request base)
  browserSessionService?: BrowserSessionService; // interactive browser sessions (browser-profiles S1) — self-scoped
  browserTickets?: TicketStore; // WS ticket store for interactive browser sessions
  browserProfileService?: BrowserProfileService; // saved authenticated browser profiles (browser-profiles S2) — self-scoped
  browserProfileCaptureService?: BrowserProfileCaptureService; // capture a session login into a profile (browser-profiles S3)
}

// The per-session context a resource's registerXTools(server, ctx) receives — the MCP twin of route-context.
export interface McpToolContext {
  deps: McpDeps;
  principal: Principal;
  ws: string; // principal.workspace
}

export function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
export function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

// authorize + AppError → isError conversion (so the agent recognizes it as a tool error / permission error).
export async function run(
  principal: Principal,
  action: Action,
  fn: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    authorize(principal, action);
    return await fn();
  } catch (err) {
    if (err instanceof AppError) return fail(`${err.code}: ${err.message}`);
    return fail(err instanceof Error ? err.message : String(err));
  }
}

// Tools with no role gate (workspace self-serve list/create). AppError → isError conversion only.
export async function plain(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError) return fail(`${err.code}: ${err.message}`);
    return fail(err instanceof Error ? err.message : String(err));
  }
}
