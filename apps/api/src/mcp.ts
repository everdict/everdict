import type { Principal } from "@everdict/auth";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerBenchmarkTools } from "./catalog/benchmark.mcp.js";
import { registerBundleTools } from "./catalog/bundle.mcp.js";
import { registerDatasetTools } from "./catalog/dataset.mcp.js";
import { registerHarnessTemplateTools } from "./catalog/harness-template.mcp.js";
import { registerHarnessTools } from "./catalog/harness.mcp.js";
import { registerJudgeTools } from "./catalog/judge.mcp.js";
import { registerModelTools } from "./catalog/model.mcp.js";
import { registerRuntimeTools } from "./catalog/runtime.mcp.js";
import { registerRunTools } from "./execution/run.mcp.js";
import { registerScorecardTools } from "./execution/scorecard.mcp.js";
import { registerCiLinkTools } from "./integrations/ci-link.mcp.js";
import { registerGithubAppTools } from "./integrations/github-app.mcp.js";
import { registerImageRegistryTools } from "./integrations/image-registry.mcp.js";
import { registerMattermostTools } from "./integrations/mattermost.mcp.js";
import { registerTraceSinkTools } from "./integrations/trace-sink.mcp.js";
import type { McpDeps, McpToolContext } from "./mcp-context.js";
import { registerBillingTools } from "./ops/billing.mcp.js";
import { registerQueueTools } from "./ops/queue.mcp.js";
import { registerRunnerLeaseTools } from "./runners/runner-lease.mcp.js";
import { registerRunnerTools } from "./runners/runner.mcp.js";
import { registerWorkspaceRunnerTools } from "./runners/workspace-runner.mcp.js";
import { registerScheduleTools } from "./scheduling/schedule.mcp.js";
import { registerApiKeyTools } from "./workspace/api-key.mcp.js";
import { registerCommentTools } from "./workspace/comment.mcp.js";
import { registerInviteTools } from "./workspace/invite.mcp.js";
import { registerMemberTools } from "./workspace/member.mcp.js";
import { registerNotificationTools } from "./workspace/notification.mcp.js";
import { registerProfileTools } from "./workspace/profile.mcp.js";
import { registerSecretTools } from "./workspace/secret.mcp.js";
import { registerSettingsTools } from "./workspace/settings.mcp.js";
import { registerViewTools } from "./workspace/view.mcp.js";
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

  // execution
  registerRunTools(server, ctx);
  registerScorecardTools(server, ctx);
  // ops
  registerQueueTools(server, ctx);
  registerBillingTools(server, ctx);
  // catalog
  registerHarnessTemplateTools(server, ctx);
  registerHarnessTools(server, ctx);
  registerDatasetTools(server, ctx);
  registerJudgeTools(server, ctx);
  registerModelTools(server, ctx);
  registerRuntimeTools(server, ctx);
  registerBenchmarkTools(server, ctx);
  registerBundleTools(server, ctx);
  // scheduling
  registerScheduleTools(server, ctx);
  // workspace
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
  // integrations
  registerGithubAppTools(server, ctx);
  registerMattermostTools(server, ctx);
  registerTraceSinkTools(server, ctx);
  registerImageRegistryTools(server, ctx);
  registerCiLinkTools(server, ctx);
  // runners
  registerRunnerTools(server, ctx);
  registerWorkspaceRunnerTools(server, ctx);
  registerRunnerLeaseTools(server, ctx);

  return server;
}
