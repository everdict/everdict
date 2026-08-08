import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, ok, run } from "../mcp-context.js";

// Agent-approval MCP tools — the MCP twin of approval.routes.ts (same ApprovalService core). A teammate's
// agent can SEE the workspace's parked asks and a member-driven session can decide them; the internal
// park/settle bridges stay HTTP-only (agent-service plumbing, not a member capability).
export function registerApprovalTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;
  if (!deps.approvalService) return;
  const approvals = deps.approvalService;

  server.registerTool(
    "list_approvals",
    {
      annotations: { readOnlyHint: true },
      description:
        "List the workspace's parked agent mutations (durable approvals — an ask survives an agent-service " +
        "restart). status filters; the pending ones are what a member can still decide.",
      inputSchema: {
        status: z.enum(["pending", "approved", "denied", "expired"]).optional(),
        session_id: z.string().optional(),
      },
    },
    ({ status, session_id }: { status?: "pending" | "approved" | "denied" | "expired"; session_id?: string }) =>
      run(principal, "agents:read", async () =>
        ok(
          await approvals.list(ws, {
            ...(status ? { status } : {}),
            ...(session_id ? { sessionId: session_id } : {}),
          }),
        ),
      ),
  );

  server.registerTool(
    "decide_approval",
    {
      annotations: { readOnlyHint: false },
      description:
        "Approve or deny a parked agent mutation. Settles exactly once (deciding an already-settled ask is a " +
        "conflict); the decision is delivered to the agent's live wait — delivered:false means the loop is " +
        "gone (restart) and the record holds the decision for the resume leg.",
      inputSchema: {
        id: z.string(),
        decision: z.enum(["approve", "deny"]),
      },
    },
    ({ id, decision }: { id: string; decision: "approve" | "deny" }) =>
      run(principal, "agents:write", async () =>
        ok(await approvals.decide({ tenant: ws, id, decision, decidedBy: principal.subject })),
      ),
  );
}
