import { CampaignAdoptionProofSchema, CampaignFrameSchema } from "@everdict/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { teamCeiling, teamOfEntity } from "../../common/team-scope.js";
import { type McpToolContext, fail, ok, run } from "../mcp-context.js";
import { gate } from "../route-context.js";

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
    () =>
      run(principal, "scorecards:read", async () =>
        ok(await campaigns.list(ws, (await teamCeiling(deps, principal)).visibleTeams)),
      ),
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
    "campaign_adoption",
    {
      annotations: { readOnlyHint: true },
      description:
        "Read the authorization an adopted close wrote, and whether it has been spent. Carries the frame " +
        "digest, the round that proved the candidate, the exact candidate spec digest and the campaign's " +
        "issue — the proof a registry write presents to claim this campaign proved its version. `decided` " +
        "means the registration is still owed: a settle that crashed before it landed is re-driven from " +
        "here rather than lost. operation is null when the campaign authorized nothing (halted, or still " +
        "open).",
      inputSchema: { id: z.string() },
    },
    ({ id }) =>
      run(principal, "scorecards:read", async () => {
        const { campaign, operation } = await campaigns.adoption(ws, id);
        return ok({ campaignId: campaign.id, state: campaign.state, operation: operation ?? null });
      }),
  );

  server.registerTool(
    "adopt_campaign_candidate",
    {
      annotations: { readOnlyHint: false },
      description:
        "Spend a settled campaign's adoption authorization on the registry write it authorizes. Present the " +
        "proof from campaign_adoption and the spec JSON being registered. The proof is compared against the " +
        "stored operation (its digest binds every coordinate), the spec's own id and version against the " +
        "authorized ones, and what the registry RESOLVES after the write against what the campaign " +
        "measured — a candidate substituted between the " +
        "evaluation and the registration is refused rather than recorded. Spendable ONCE: a retry of the " +
        "same adoption converges (already_adopted) instead of granting a second one. Requires " +
        "scorecards:run and the candidate family's write action.",
      inputSchema: {
        id: z.string().describe("campaign id"),
        proof: z.string().describe("CampaignAdoptionProof JSON, exactly as campaign_adoption returned it"),
        spec: z.string().describe("The AgentSpec / HarnessInstanceSpec JSON being registered"),
      },
    },
    ({ id, proof, spec }) =>
      run(principal, "scorecards:run", async () => {
        if (!deps.campaignAdoption) return fail("NOT_FOUND: campaign adoption is not configured.");
        let parsedProof: unknown;
        let parsedSpec: unknown;
        try {
          parsedProof = JSON.parse(proof);
          parsedSpec = JSON.parse(spec);
        } catch {
          return fail("BAD_REQUEST: proof and spec must both be valid JSON.");
        }
        const checked = CampaignAdoptionProofSchema.safeParse(parsedProof);
        if (!checked.success) return fail(`BAD_REQUEST: ${checked.error.message}`);
        // The family's write action AND the team that owns the entity, gated like the route: preserving an
        // owner team is not the same question as being allowed to write to it (arch-review 76 P1-security).
        const candidate = checked.data.candidate;
        const owner =
          candidate.type === "agent"
            ? await teamOfEntity(deps.agentRegistry, ws, candidate.id)
            : await teamOfEntity(deps.harnessInstances, ws, candidate.id);
        gate(principal, candidate.type === "agent" ? "agents:write" : "harnesses:register", owner);
        return ok(
          await deps.campaignAdoption.adopt({
            tenant: ws,
            campaignId: id,
            proof: checked.data,
            candidate: {
              type: candidate.type,
              id: candidate.id,
              version: candidate.version,
              ...(candidate.specDigest !== undefined ? { specDigest: candidate.specDigest } : {}),
            },
            spec: parsedSpec,
            by: principal.subject,
            via: "mcp",
          }),
        );
      }),
  );

  server.registerTool(
    "settle_campaign",
    {
      annotations: { readOnlyHint: false },
      description:
        "Settle per the gate's answer: close as adopted (version + proving scorecard + waived axes recorded) " +
        "or as the gate's own ending. Refuses (CONFLICT) while the gate answers continue or " +
        "identity_unverified. Adoption approval is over THIS answer. " +
        "An ADOPTED close writes a durable adoption operation in the same statement — the authorization a " +
        "registry write must present to claim this campaign proved its version. It carries the frame " +
        "digest, the round that proved it, the exact candidate spec digest and the campaign's issue, and it " +
        "is spendable ONCE. Registering the adopted version presents that proof; registering different " +
        "bytes under the same label is refused by it. A campaign that crashed after settling still has the " +
        "operation, so the registration can be re-driven rather than lost.",
      inputSchema: { id: z.string() },
    },
    ({ id }) => run(principal, "scorecards:run", async () => ok(await campaigns.settle(ws, id, principal.subject))),
  );
}
