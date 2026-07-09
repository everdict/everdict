import { type Action, type Principal, authorize } from "@everdict/auth";
import type { UsageMeter } from "@everdict/billing";
import { AppError, type RuntimeSpec } from "@everdict/core";
import type { SecretStore, TenantKeyStore, WorkspaceSettingsStore } from "@everdict/db";
import type {
  DatasetRegistry,
  HarnessInstanceRegistry,
  HarnessTemplateRegistry,
  JudgeRegistry,
  ModelRegistry,
  RuntimeRegistry,
} from "@everdict/registry";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { BudgetAdmin } from "../common/budget-tracker.js";
import type { BenchmarkService } from "../core/benchmark/benchmark-service.js";
import type { BundleService } from "../core/bundle/bundle-service.js";
import type { CiLinkService } from "../core/ci-link/ci-link-service.js";
import type { CommentService } from "../core/comment/comment-service.js";
import type { GithubAppService } from "../core/github-app/github-app-service.js";
import type { ImageRegistryService } from "../core/image-registry/image-registry-service.js";
import type { MattermostService } from "../core/mattermost/mattermost-service.js";
import type { MembershipService } from "../core/member/membership-service.js";
import type { NotificationService } from "../core/notification/notification-service.js";
import type { RuntimeProbeResult } from "../core/ops/runtime-probe.js";
import type { ProfileService } from "../core/profile/profile-service.js";
import type { QueueService } from "../core/queue/queue-service.js";
import type { RunService } from "../core/run/run-service.js";
import type { RunnerHub } from "../core/runner/runner-hub.js";
import type { RunnerService } from "../core/runner/runner-service.js";
import type { ScheduleService } from "../core/schedule/schedule-service.js";
import type { ScorecardService } from "../core/scorecard/scorecard-service.js";
import type { TraceSinkService } from "../core/trace-sink/trace-sink-service.js";
import type { ViewService } from "../core/view/view-service.js";
import type { WorkspaceService } from "../core/workspace/workspace-service.js";

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
  modelRegistry?: ModelRegistry; // Model (inference/judgment model) register/read — judge and command harnesses reference it by id
  runtimeRegistry?: RuntimeRegistry;
  probeRuntime?: (workspace: string, spec: RuntimeSpec) => Promise<RuntimeProbeResult>; // runtime connection test
  secretStore?: SecretStore;
  githubAppService?: GithubAppService; // workspace-owned GitHub App integration (org install → selected repos)
  mattermostService?: MattermostService; // workspace-owned Mattermost integration (register → bot notifications)
  traceSinkService?: TraceSinkService; // workspace trace sinks (export to an observability platform)
  imageRegistryService?: ImageRegistryService; // workspace image registry (classification baseline + push publishing)
  ciLinkService?: CiLinkService; // CI repo link (repo↔harness slot + OIDC trust) + picker/setup-PR
  runnerService?: RunnerService; // self-hosted runners (personal device pairing) — pair/list/revoke + workspace roster
  notificationService?: NotificationService; // personal notification feed (bell inbox) — list/read (self-scoped)
  commentService?: CommentService; // resource comments (datasets, etc.) — list/create/delete
  runnerHub?: RunnerHub; // runner lease hub — lease_job/submit_job_result/fail_job/heartbeat_job (runner token only)
  settingsStore?: WorkspaceSettingsStore;
  benchmarkService?: BenchmarkService; // benchmark preview + import (source → dataset)
  bundleService?: BundleService; // bundle one-shot apply (harness + benchmark + runtime, etc.)
  workspaceService?: WorkspaceService; // workspace self-serve list/create (no role gate — by subject)
  membershipService?: MembershipService; // member management (list/role/remove/leave) + invites (issue/accept)
  profileService?: ProfileService; // my profile (name/username/avatar) read/edit (self-serve)
  keyStore?: TenantKeyStore; // API key self-serve issue/list/revoke (admin)
  apiPublicUrl?: string; // control-plane public base — the everdict runner --api-url in github_install_workspace_runner (falls back to the request base)
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
