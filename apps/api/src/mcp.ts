import type { Principal } from "@everdict/auth";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerApiKeyTools } from "./api/api-key/api-key.mcp.js";
import { registerBenchmarkTools } from "./api/benchmark/benchmark.mcp.js";
import { registerBillingTools } from "./api/billing/billing.mcp.js";
import { registerBundleTools } from "./api/bundle/bundle.mcp.js";
import { registerCiLinkTools } from "./api/ci-link/ci-link.mcp.js";
import { registerCommentTools } from "./api/comment/comment.mcp.js";
import { registerDatasetTools } from "./api/dataset/dataset.mcp.js";
import { registerGithubAppTools } from "./api/github-app/github-app.mcp.js";
import { registerHarnessTemplateTools } from "./api/harness/harness-template.mcp.js";
import { registerHarnessTools } from "./api/harness/harness.mcp.js";
import { registerImageRegistryTools } from "./api/image-registry/image-registry.mcp.js";
import { registerJudgeTools } from "./api/judge/judge.mcp.js";
import { registerMattermostTools } from "./api/mattermost/mattermost.mcp.js";
import type { McpDeps, McpToolContext } from "./api/mcp-context.js";
import { registerInviteTools } from "./api/member/invite.mcp.js";
import { registerMemberTools } from "./api/member/member.mcp.js";
import { registerModelTools } from "./api/model/model.mcp.js";
import { registerNotificationTools } from "./api/notification/notification.mcp.js";
import { registerProfileTools } from "./api/profile/profile.mcp.js";
import { registerQueueTools } from "./api/queue/queue.mcp.js";
import { registerRubricTools } from "./api/rubric/rubric.mcp.js";
import { registerRunTools } from "./api/run/run.mcp.js";
import { registerRunnerLeaseTools } from "./api/runner/runner-lease.mcp.js";
import { registerRunnerTools } from "./api/runner/runner.mcp.js";
import { registerWorkspaceRunnerTools } from "./api/runner/workspace-runner.mcp.js";
import { registerRuntimeTools } from "./api/runtime/runtime.mcp.js";
import { registerScheduleTools } from "./api/schedule/schedule.mcp.js";
import { registerScorecardTools } from "./api/scorecard/scorecard.mcp.js";
import { registerSecretTools } from "./api/secret/secret.mcp.js";
import { registerTraceSinkTools } from "./api/trace-sink/trace-sink.mcp.js";
import { registerTraceSourceTools } from "./api/trace-source/trace-source.mcp.js";
import { registerViewTools } from "./api/view/view.mcp.js";
import { registerSettingsTools } from "./api/workspace/settings.mcp.js";
import { registerWorkspaceTools } from "./api/workspace/workspace.mcp.js";

export type { McpDeps, McpToolContext } from "./api/mcp-context.js";

// MCP composition root — the second transport over the same service core as the HTTP routes.
// Tool bodies live in the owning resource slice (<domain>/<resource>.mcp.ts, next to <resource>.routes.ts);
// this file only builds the per-Principal server (stateless per-request instance) and registers each slice's tools.
export function buildMcpServer(deps: McpDeps, principal: Principal): McpServer {
  const server = new McpServer(
    { name: "everdict", version: "0.1.0" },
    { instructions: "Everdict eval control plane. Workspace-scoped run/harness tools." },
  );
  const ctx: McpToolContext = { deps, principal, ws: principal.workspace };

  registerRunTools(server, ctx);
  registerScorecardTools(server, ctx);
  registerQueueTools(server, ctx);
  registerBillingTools(server, ctx);
  registerHarnessTemplateTools(server, ctx);
  registerHarnessTools(server, ctx);
  registerDatasetTools(server, ctx);
  registerJudgeTools(server, ctx);
  registerRubricTools(server, ctx);
  registerModelTools(server, ctx);
  registerRuntimeTools(server, ctx);
  registerBenchmarkTools(server, ctx);
  registerBundleTools(server, ctx);
  registerScheduleTools(server, ctx);
  registerViewTools(server, ctx);
  registerSecretTools(server, ctx);
  registerNotificationTools(server, ctx);
  registerCommentTools(server, ctx);
  registerApiKeyTools(server, ctx);
  registerMemberTools(server, ctx);
  registerInviteTools(server, ctx);
  registerWorkspaceTools(server, ctx);
  registerProfileTools(server, ctx);
  registerSettingsTools(server, ctx);
  registerGithubAppTools(server, ctx);
  registerMattermostTools(server, ctx);
  registerTraceSinkTools(server, ctx);
  registerTraceSourceTools(server, ctx);
  registerImageRegistryTools(server, ctx);
  registerCiLinkTools(server, ctx);
  registerRunnerTools(server, ctx);
  registerWorkspaceRunnerTools(server, ctx);
  registerRunnerLeaseTools(server, ctx);

  return server;
}
