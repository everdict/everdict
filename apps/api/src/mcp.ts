import type { Principal } from "@everdict/auth";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerApiKeyTools } from "./api-key/api-key.mcp.js";
import { registerBenchmarkTools } from "./benchmark/benchmark.mcp.js";
import { registerBillingTools } from "./billing/billing.mcp.js";
import { registerBundleTools } from "./bundle/bundle.mcp.js";
import { registerCiLinkTools } from "./ci-link/ci-link.mcp.js";
import { registerCommentTools } from "./comment/comment.mcp.js";
import { registerDatasetTools } from "./dataset/dataset.mcp.js";
import { registerGithubAppTools } from "./github-app/github-app.mcp.js";
import { registerHarnessTemplateTools } from "./harness/harness-template.mcp.js";
import { registerHarnessTools } from "./harness/harness.mcp.js";
import { registerImageRegistryTools } from "./image-registry/image-registry.mcp.js";
import { registerJudgeTools } from "./judge/judge.mcp.js";
import { registerMattermostTools } from "./mattermost/mattermost.mcp.js";
import type { McpDeps, McpToolContext } from "./mcp-context.js";
import { registerInviteTools } from "./member/invite.mcp.js";
import { registerMemberTools } from "./member/member.mcp.js";
import { registerModelTools } from "./model/model.mcp.js";
import { registerNotificationTools } from "./notification/notification.mcp.js";
import { registerProfileTools } from "./profile/profile.mcp.js";
import { registerQueueTools } from "./queue/queue.mcp.js";
import { registerRunTools } from "./run/run.mcp.js";
import { registerRunnerLeaseTools } from "./runner/runner-lease.mcp.js";
import { registerRunnerTools } from "./runner/runner.mcp.js";
import { registerWorkspaceRunnerTools } from "./runner/workspace-runner.mcp.js";
import { registerRuntimeTools } from "./runtime/runtime.mcp.js";
import { registerScheduleTools } from "./schedule/schedule.mcp.js";
import { registerScorecardTools } from "./scorecard/scorecard.mcp.js";
import { registerSecretTools } from "./secret/secret.mcp.js";
import { registerTraceSinkTools } from "./trace-sink/trace-sink.mcp.js";
import { registerViewTools } from "./view/view.mcp.js";
import { registerSettingsTools } from "./workspace/settings.mcp.js";
import { registerWorkspaceTools } from "./workspace/workspace.mcp.js";

export type { McpDeps, McpToolContext } from "./mcp-context.js";

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
  registerImageRegistryTools(server, ctx);
  registerCiLinkTools(server, ctx);
  registerRunnerTools(server, ctx);
  registerWorkspaceRunnerTools(server, ctx);
  registerRunnerLeaseTools(server, ctx);

  return server;
}
