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

  const body = HandoffCheckpointSchema.omit({ id: true, createdAt: true, createdBy: true }).extend({
    // The policy slice of the envelope being suspended — carrying it lets admission enforce
    // rollbackRequired ⇒ rollbackPlan (stricter only; envelopes are not persisted). HTTP parity.
    envelope: z.object({ id: z.string().min(1), rollbackRequired: z.boolean().optional() }).optional(),
  });

  server.registerTool(
    "publish_checkpoint",
    {
      annotations: { readOnlyHint: false },
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
      run(principal, "agents:write", async () => {
        const { envelope, ...checkpoint } = body.parse(a);
        return ok(
          await checkpoints.create({
            tenant: ws,
            createdBy: principal.subject,
            checkpoint,
            ...(envelope ? { envelope } : {}),
          }),
        );
      }),
  );

  server.registerTool(
    "list_checkpoints",
    {
      annotations: { readOnlyHint: true },
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

  // The LEAD's judgment, as a tool it can call about work it delegated. Deliberately not automatic: a handoff
  // does not wake a verifier (`checkpoint.created` is not trigger-matchable — an agent waking on another
  // agent's handoff is the runaway vector the agent.run.* family is excluded for), so asking for one is a
  // decision someone makes rather than an ambient reaction.
  server.registerTool(
    "request_verification",
    {
      description:
        "Ask an INDEPENDENT verifier to check a checkpoint's claims against the evidence it cites. The " +
        "verifier runs inside an evidence-only envelope — no write capability at all, reads restricted to " +
        "the tools that reach that evidence, and the objects pinned to the cited refs — so its conclusion is " +
        "attributable to what it was given and nothing else. It cannot be you: a verifier that executed the " +
        "work is refused, and so is one running in the same run or session. The verdict is filed as a " +
        "durable decision that records what was actually read; a 'verified' with a ref nobody read comes " +
        "back INCONCLUSIVE with the gap named, because an unchecked half is a species of could-not-tell. " +
        "Use it when a handoff's claims matter more than the cost of checking them.",
      inputSchema: {
        id: z.string().describe("checkpoint id"),
        focus: z
          .string()
          .max(600)
          .optional()
          .describe(
            "where the verifier should look — a hint, not an instruction. What 'verified' means, how a contradiction is handled and what insufficient evidence answers are the platform's rules and cannot be changed from here.",
          ),
      },
    },
    ({ id, focus }) =>
      run(principal, "agents:write", async () =>
        ok(
          await checkpoints.requestVerification(ws, id, {
            ...(focus !== undefined ? { focus } : {}),
            requestedBy: principal.subject,
          }),
        ),
      ),
  );

  server.registerTool(
    "get_checkpoint",
    {
      annotations: { readOnlyHint: true },
      description:
        "Read one handoff checkpoint in full — confirmed facts with their evidence, hypotheses, actions " +
        "taken, open decisions, remaining tasks, the validation plan and any rollback plan. This is what " +
        "you resume FROM; start with the facts and their refs, not the narrative.",
      inputSchema: { id: z.string() },
    },
    ({ id }) => run(principal, "agents:read", async () => ok(await checkpoints.get(ws, id))),
  );
}
