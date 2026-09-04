import { CampaignAdoptionProofSchema, CampaignFrameFromIssueSchema, CampaignFrameSchema } from "@everdict/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, fail, ok, run } from "../mcp-context.js";
import { gate } from "../route-context.js";
import { LogCampaignRoundBodySchema } from "./request/log-campaign-round.js";

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
        frame: z
          .union([CampaignFrameSchema, CampaignFrameFromIssueSchema])
          .describe(
            "a full frame, or { fromIssue: true, … } to derive scenarios + targets from the issue's case links",
          ),
      },
    },
    ({ issue_id, frame }) =>
      run(principal, "scorecards:run", async () => {
        // The issue is READ before the campaign opens, not for a gate but because a campaign against an issue
        // that is not there is a campaign about nothing — the service would fail the same way, later and with
        // a worse message. Parity with the route.
        if (!deps.issueService) return fail("NOT_FOUND: issue service is not configured.");
        const issue = await deps.issueService.get(ws, issue_id);
        if (issue === undefined) return fail("NOT_FOUND: issue not found.");
        gate(principal, "scorecards:run");
        return ok(await campaigns.open(ws, { issueId: issue_id, frame }, principal.subject));
      }),
  );

  server.registerTool(
    "list_campaigns",
    {
      annotations: { readOnlyHint: true },
      description:
        "The workspace's evolution campaigns. With subject_type + subject_id: ONE capability's evolution memory — " +
        "every campaign ever opened on it (any version), each with its rounds (verdict, evidence reference, learned) " +
        "and its close. Read it before proposing a first hypothesis, so a dead one is not spent twice.",
      inputSchema: {
        subject_type: z.enum(["agent", "harness"]).optional(),
        subject_id: z.string().optional(),
      },
    },
    ({ subject_type, subject_id }) =>
      run(principal, "scorecards:read", async () => {
        if ((subject_type === undefined) !== (subject_id === undefined))
          return fail("BAD_REQUEST: subject_type and subject_id go together — name both, or neither.");
        const subject =
          subject_type !== undefined && subject_id !== undefined ? { type: subject_type, id: subject_id } : undefined;
        return ok(await campaigns.list(ws, subject));
      }),
  );

  server.registerTool(
    "get_campaign",
    {
      annotations: { readOnlyHint: true },
      description: "Read one campaign — frame, round trace, state, and close",
      inputSchema: { id: z.string() },
    },
    ({ id }) =>
      run(principal, "scorecards:read", async () => {
        const record = await campaigns.get(ws, id);
        return ok(record);
      }),
  );

  server.registerTool(
    "log_campaign_round",
    {
      annotations: { readOnlyHint: false },
      description:
        "Record one tested hypothesis. The verdict is DERIVED from the production scorecard diff (trial " +
        "statistics under the frame's frozen significance + experiment identity) — it is never accepted " +
        "from the caller. Answers the round plus the adoption gate's verdict over the new trace. A " +
        "concurrent round answers CONFLICT: re-read the campaign and log against its current state. Also " +
        "CONFLICT once the frame's own ending has fired — the budget is spent, or the rejected streak was " +
        "reached: the campaign is over by its own rule, ask campaign_decision and settle it.",
      // ── THE SAME BOUNDS AS THE HTTP TWIN, FROM THE SAME SCHEMA ────────────────────────────────────
      //
      // This tool declared bare `z.string()`s while the DTO bounded every field, and the service appended
      // the round unparsed — so a round logged here with an empty hypothesis or a 4001-character finding was
      // stored, and the Postgres read (which decodes rows through the record schema) then failed for that
      // campaign and for the workspace's whole list. The service now refuses such a round on every door;
      // declaring the bounds here too means the agent is told at the tool boundary, with the field named.
      inputSchema: {
        id: z.string(),
        hypothesis: LogCampaignRoundBodySchema.shape.hypothesis.describe(
          "One variable per round — what this candidate changes and why",
        ),
        // The knowledge layer, required here exactly as it is on the HTTP twin. What the round TAUGHT is a
        // different question from what it scored, and it is the half a rejected round is otherwise pure
        // spend for — the next proposal reads it, the adoption gate never does.
        learned: LogCampaignRoundBodySchema.shape.learned.describe(
          "What this round taught the walk — the failure mode or the confirmed mechanism, not the outcome. Read by the next proposal; never by the adoption gate.",
        ),
        candidate_version: LogCampaignRoundBodySchema.shape.candidateVersion,
        baseline_scorecard_id: LogCampaignRoundBodySchema.shape.baselineScorecardId,
        candidate_scorecard_id: LogCampaignRoundBodySchema.shape.candidateScorecardId,
        delegation_run_id: LogCampaignRoundBodySchema.shape.delegationRunId.describe(
          "The sandbox session (its run id) whose delegate produced this candidate. Required when the frame budgets the delegation; the platform records what the session cost from the run ledger.",
        ),
      },
    },
    ({
      id,
      hypothesis,
      learned,
      candidate_version,
      baseline_scorecard_id,
      candidate_scorecard_id,
      delegation_run_id,
    }) =>
      run(principal, "scorecards:run", async () => {
        gate(principal, "scorecards:run");
        return ok(
          await campaigns.logRound(
            ws,
            id,
            {
              hypothesis,
              learned,
              candidateVersion: candidate_version,
              baselineScorecardId: baseline_scorecard_id,
              candidateScorecardId: candidate_scorecard_id,
              ...(delegation_run_id !== undefined ? { delegationRunId: delegation_run_id } : {}),
            },
            principal.subject,
          ),
        );
      }),
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
    ({ id }) =>
      run(principal, "scorecards:read", async () => {
        return ok(await campaigns.decision(ws, id));
      }),
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
        // The campaign is READ before the adoption is authorized — its own record, never the copy on the proof
        // the caller handed over (rule `protocol` L3). Same as the route: BFF↔MCP parity means the same
        // GUARDS, not just the same service.
        gate(principal, "scorecards:run");
        const candidate = checked.data.candidate;
        // Three subject types, three registries, three actions — the HTTP twin's routing, verbatim
        // (harness-definability-spec.md §2).
        const action = {
          agent: "agents:write",
          environment: "datasets:write",
          harness: "harnesses:register",
        } as const;
        gate(principal, action[candidate.type]);
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
            // The agent that acted, so the fact this write emits carries the loop guard's key — without it
            // the agent that adopted a candidate is woken by its own adoption (arch-review 85).
            ...(ctx.agent !== undefined ? { agent: ctx.agent } : {}),
          }),
        );
      }),
  );

  server.registerTool(
    "build_campaign_candidate",
    {
      annotations: { readOnlyHint: false },
      description:
        "Build a code-evolution candidate image INTO Everdict's own managed store — no outside CI. Everdict boots " +
        "the harness slot's base image, checks out the commit (ref/repo/prNumber), runs the template's frozen " +
        "build steps, and publishes the result as one layer, minting a new harness instance version. Returns the " +
        "`building` record; poll get_campaign_builds or subscribe to campaign.candidate_built for the result. " +
        "The round then logs that minted version as its candidate, and its candidateSource is Everdict's own " +
        "account of the build (execution_world held, no identity waiver). Requires scorecards:run and " +
        "harnesses:register.",
      inputSchema: {
        id: z.string().describe("campaign id"),
        ref: z.string().describe("What to check out — a pull-request head sha, a branch, or a tag"),
        repo: z.string().optional().describe('"owner/name" when the ref is a GitHub pull request'),
        pr_number: z.number().int().optional(),
        slot: z.string().optional().describe("Which slot to rebuild — omit when the template has one buildable slot"),
        slots: z
          .array(z.string().min(1))
          .min(2)
          .optional()
          .describe(
            "A BUILD SET: two or more slots rebuilt from the same head and minted as ONE candidate version (one pull request, several services). Exclusive with slot.",
          ),
      },
    },
    ({ id, ref, repo, pr_number, slot, slots }) =>
      run(principal, "scorecards:run", async () => {
        if (!deps.campaignBuild) return fail("NOT_FOUND: campaign build is not configured.");
        gate(principal, "scorecards:run");
        gate(principal, "harnesses:register");
        if (slots !== undefined && slot !== undefined)
          return fail("BAD_REQUEST: name slots for a build set, or slot for one build — not both.");
        if (slots !== undefined) {
          const set = await deps.campaignBuild.startSet(
            ws,
            {
              campaignId: id,
              ref,
              ...(repo !== undefined ? { repo } : {}),
              ...(pr_number !== undefined ? { prNumber: pr_number } : {}),
              slots,
            },
            principal.subject,
          );
          const build = deps.campaignBuild;
          void build.runSet(ws, set.id).catch(() => undefined);
          return ok(set);
        }
        const record = await deps.campaignBuild.start(
          ws,
          {
            campaignId: id,
            ref,
            ...(repo !== undefined ? { repo } : {}),
            ...(pr_number !== undefined ? { prNumber: pr_number } : {}),
            ...(slot !== undefined ? { slot } : {}),
          },
          principal.subject,
        );
        const build = deps.campaignBuild;
        void build.run(ws, record.id).catch(() => undefined);
        return ok(record);
      }),
  );

  server.registerTool(
    "get_campaign_round_evidence",
    {
      annotations: { readOnlyHint: true },
      description:
        "The platform-derived evidence one round sealed — per compared case: held-out / target flags, both sides' " +
        "pass rates and trials, the per-case verdict (improved · regressed · unchanged · unclear) and the run ids " +
        "to read its traces from. Read THIS to build the next brief (the failing target ids and where they failed), " +
        "never the driver's own notes. Served from the immutable object the round names by key + digest; refused " +
        "when the bytes no longer match.",
      inputSchema: { id: z.string(), seq: z.number().int().positive().describe("the round's sequence number") },
    },
    ({ id, seq }) =>
      run(principal, "scorecards:read", async () => {
        return ok(await campaigns.roundEvidence(ws, id, seq));
      }),
  );

  server.registerTool(
    "get_campaign_round_brief",
    {
      annotations: { readOnlyHint: true },
      description:
        "The next round's DELEGATION BRIEF, authored by the platform from the frozen frame and the last round's " +
        "sealed evidence: goal (the cases to flip, as a condition on the subject), context (which round, what " +
        "earlier rounds established about the mechanism), references (the issue, the baseline, the last candidate " +
        "batch, one candidate-side trace per target still failing), constraints (the oracle's paths, one lever, " +
        "the candidate must differ in bytes) and doneWhen (checks the delegate can run in its own sandbox — the " +
        "repository's build and tests, never the scorecard). Pass it straight to create_sandbox as `brief`. " +
        "Held-out ids, pass rates and judge rationale are excluded by construction: a delegate shown the " +
        "generalization population has been aimed at it, which is what makes the round's evidence worthless.",
      inputSchema: { id: z.string() },
    },
    ({ id }) =>
      run(principal, "scorecards:read", async () => {
        return ok(await campaigns.roundBrief(ws, id));
      }),
  );

  server.registerTool(
    "get_campaign_build_sets",
    {
      annotations: { readOnlyHint: true },
      description:
        "The campaign's build SETS — several slots rebuilt from one head and minted as one version: members, observed commit, slot → image, the minted version or the failure",
      inputSchema: { id: z.string() },
    },
    ({ id }) =>
      run(principal, "scorecards:read", async () => {
        if (!deps.campaignBuild) return fail("NOT_FOUND: campaign build is not configured.");
        return ok(await deps.campaignBuild.setsForCampaign(ws, id));
      }),
  );

  server.registerTool(
    "get_campaign_builds",
    {
      annotations: { readOnlyHint: true },
      description:
        "Everdict's build ledger for a campaign — each candidate build's commit, image, minted version and state",
      inputSchema: { id: z.string() },
    },
    ({ id }) =>
      run(principal, "scorecards:read", async () => {
        if (!deps.campaignBuild) return fail("NOT_FOUND: campaign build is not configured.");
        return ok(await deps.campaignBuild.forCampaign(ws, id));
      }),
  );

  server.registerTool(
    "merge_campaign_candidate",
    {
      annotations: { readOnlyHint: false },
      description:
        "Pay a settled campaign's CODE debt: merge the pull request the adopted bytes were built from into its " +
        "repository's default branch, through the workspace GitHub App, asserting the head the round measured. " +
        "The repository and pull request come from the stored operation (the candidate scorecard's origin), never " +
        "from you; present the proof from campaign_adoption. Requires the bytes to be registered first " +
        "(adopt_campaign_candidate). Refuses when the adoption carries no code debt or the proof is not the " +
        "recorded one; a retry converges (already_merged). A chain (`continues`) cannot start from an adoption " +
        "whose code is still owed. Requires scorecards:run and the candidate family's write action.",
      inputSchema: {
        id: z.string().describe("campaign id"),
        proof: z.string().describe("CampaignAdoptionProof JSON, exactly as campaign_adoption returned it"),
      },
    },
    ({ id, proof }) =>
      run(principal, "scorecards:run", async () => {
        if (!deps.campaignAdoption) return fail("NOT_FOUND: campaign adoption is not configured.");
        let parsedProof: unknown;
        try {
          parsedProof = JSON.parse(proof);
        } catch {
          return fail("BAD_REQUEST: proof must be valid JSON.");
        }
        const checked = CampaignAdoptionProofSchema.safeParse(parsedProof);
        if (!checked.success) return fail(`BAD_REQUEST: ${checked.error.message}`);
        // same authorization spent on its second effect (parity with the route).
        gate(principal, "scorecards:run");
        const candidate = checked.data.candidate;
        // Three subject types, three registries, three actions — the HTTP twin's routing, verbatim
        // (harness-definability-spec.md §2).
        const action = {
          agent: "agents:write",
          environment: "datasets:write",
          harness: "harnesses:register",
        } as const;
        gate(principal, action[candidate.type]);
        return ok(
          await deps.campaignAdoption.merge({
            tenant: ws,
            campaignId: id,
            proof: checked.data,
            by: principal.subject,
            via: "mcp",
            ...(ctx.agent !== undefined ? { agent: ctx.agent } : {}),
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
    ({ id }) =>
      run(principal, "scorecards:run", async () => {
        gate(principal, "scorecards:run");
        return ok(await campaigns.settle(ws, id, principal.subject));
      }),
  );
}
