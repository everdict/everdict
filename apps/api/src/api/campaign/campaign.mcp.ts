import { CampaignFrameSchema } from "@everdict/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { teamCeiling } from "../../common/team-scope.js";
import { type McpToolContext, ok, run } from "../mcp-context.js";

// Evolution campaigns — MCP twin of the /campaigns routes (BFF↔MCP parity: same service, second transport).
// This is the surface the agent-evolve loop drives; the tools' descriptions teach the settlement's rules.
export function registerCampaignTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;
  if (!deps.campaignService) return;
  const campaigns = deps.campaignService;

  server.registerTool(
    "open_campaign",
    {
      annotations: { readOnlyHint: false },
      description:
        "Open an evolution campaign: freeze the frame (subject, scenarios with held-out marked, judges, " +
        "trials per case, round budget, significance, the identity waiver) and record its digest. The frame " +
        "is immutable — weakening judges/scenarios mid-campaign is impossible by construction; a different " +
        "frame is a new campaign. issue_id is the campaign's journal (the issue links scorecards and carries " +
        "the resolution).",
      inputSchema: {
        issue_id: z.string().describe("The issue this campaign journals into (id or identifier)"),
        frame: CampaignFrameSchema,
      },
    },
    ({ issue_id, frame }) =>
      run(principal, "scorecards:run", async () =>
        ok(await campaigns.open(ws, { issueId: issue_id, frame }, principal.subject)),
      ),
  );

  server.registerTool(
    "list_campaigns",
    { annotations: { readOnlyHint: true }, description: "The workspace's evolution campaigns", inputSchema: {} },
    () => run(principal, "scorecards:read", async () => ok(await campaigns.list(ws))),
  );

  server.registerTool(
    "get_campaign",
    {
      annotations: { readOnlyHint: true },
      description: "Read one campaign — frame, round trace, state, and close",
      inputSchema: { id: z.string() },
    },
    ({ id }) => run(principal, "scorecards:read", async () => ok(await campaigns.get(ws, id))),
  );

  server.registerTool(
    "log_campaign_round",
    {
      annotations: { readOnlyHint: false },
      description:
        "Record one tested hypothesis. The verdict is DERIVED from the production scorecard diff (trial " +
        "statistics under the frame's frozen significance + experiment identity) — it is never accepted " +
        "from the caller. Answers the round plus the adoption gate's verdict over the new trace. A " +
        "concurrent round answers CONFLICT: re-read the campaign and log against its current state.",
      inputSchema: {
        id: z.string(),
        hypothesis: z.string().describe("One variable per round — what this candidate changes and why"),
        candidate_version: z.string(),
        baseline_scorecard_id: z.string(),
        candidate_scorecard_id: z.string(),
      },
    },
    ({ id, hypothesis, candidate_version, baseline_scorecard_id, candidate_scorecard_id }) =>
      run(principal, "scorecards:run", async () =>
        ok(
          await campaigns.logRound(
            ws,
            id,
            {
              hypothesis,
              candidateVersion: candidate_version,
              baselineScorecardId: baseline_scorecard_id,
              candidateScorecardId: candidate_scorecard_id,
            },
            principal.subject,
            await teamCeiling(deps, principal),
          ),
        ),
      ),
  );

  server.registerTool(
    "campaign_decision",
    {
      annotations: { readOnlyHint: true },
      description:
        "Ask the pure adoption gate: adopt (latest candidate significantly better, zero regressions, world " +
        "identity verified or waived at open) | continue | halt (no_improvement / budget_exhausted / " +
        "identity_unverified — the last refuses adoption but keeps the campaign open).",
      inputSchema: { id: z.string() },
    },
    ({ id }) => run(principal, "scorecards:read", async () => ok(await campaigns.decision(ws, id))),
  );

  server.registerTool(
    "settle_campaign",
    {
      annotations: { readOnlyHint: false },
      description:
        "Settle per the gate's answer: close as adopted (version + proving scorecard + waived axes recorded) " +
        "or as the gate's own ending. Refuses (CONFLICT) while the gate answers continue or " +
        "identity_unverified. Adoption approval is over THIS answer. Afterwards, register the adopted " +
        "version declaring the campaign's issue as its origin — register_harness and save_agent both take " +
        "fromIssue: a first version records born_from intent, and a bump records the base it succeeds, so " +
        "lineage and intent both land in the graph.",
      inputSchema: { id: z.string() },
    },
    ({ id }) => run(principal, "scorecards:run", async () => ok(await campaigns.settle(ws, id, principal.subject))),
  );
}
