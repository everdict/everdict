import { HandoffCheckpointSchema } from "@everdict/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, ok, run } from "../mcp-context.js";

// Handoff checkpoints over MCP — the transport an AGENT actually reaches this through, which is the point:
// the host writes a checkpoint when a task halts, and the successor reads one when it picks the task up.
// Same service as the routes; authz reuses agents:read / agents:write (no new action).
export function registerCheckpointTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;
  if (!deps.checkpointService) return;
  const checkpoints = deps.checkpointService;

  const body = HandoffCheckpointSchema.omit({ id: true, createdAt: true, createdBy: true });

  server.registerTool(
    "publish_checkpoint",
    {
      description:
        "Publish a handoff checkpoint — a resumable state transfer for work that is stopping (budget " +
        "exhausted, scope refused, or handing off deliberately). A successor decides its next action from " +
        "your evidence REFERENCES, not your prose: every confirmedFacts entry needs at least one ref " +
        "(run/scorecard/commit/issue/trace/file) and the call is REFUSED if a referenced record does not " +
        "exist. Anything you believe but cannot point at goes in hypotheses — that is what the field is " +
        "for, and claiming it as a fact is the failure this contract exists to prevent. id, timestamp and " +
        "authorship are stamped for you.",
      inputSchema: body.shape,
    },
    (a) =>
      run(principal, "agents:write", async () =>
        ok(
          await checkpoints.create({
            tenant: ws,
            createdBy: principal.subject,
            checkpoint: body.parse(a),
          }),
        ),
      ),
  );

  server.registerTool(
    "list_checkpoints",
    {
      description:
        "Handoff checkpoints in this workspace, newest first. envelopeId narrows to one task's handoffs — " +
        "how that task stopped and what it left behind.",
      inputSchema: {
        envelopeId: z.string().optional().describe("Only checkpoints suspending this task envelope"),
        limit: z.number().int().positive().optional().describe("Maximum rows (default 200)"),
      },
    },
    (a) =>
      run(principal, "agents:read", async () =>
        ok(
          await checkpoints.list(ws, {
            ...(a.envelopeId !== undefined ? { envelopeId: a.envelopeId } : {}),
            ...(a.limit !== undefined ? { limit: a.limit } : {}),
          }),
        ),
      ),
  );

  server.registerTool(
    "get_checkpoint",
    {
      description:
        "Read one handoff checkpoint in full — confirmed facts with their evidence, hypotheses, actions " +
        "taken, open decisions, remaining tasks, the validation plan and any rollback plan. This is what " +
        "you resume FROM; start with the facts and their refs, not the narrative.",
      inputSchema: { id: z.string() },
    },
    ({ id }) => run(principal, "agents:read", async () => ok(await checkpoints.get(ws, id))),
  );
}
