import { ChangeJudgementAnswerSchema, ChangeSetEntrySchema, GateRunSchema } from "@everdict/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, ok, run } from "../mcp-context.js";
import { DeclarableCriterionSchema } from "./request/change-campaign-requests.js";

// The `change` grade's MCP half — the same service functions the routes call (BFF↔MCP parity is structural).
export function registerChangeCampaignTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;
  const svc = deps.changeCampaignService;
  if (!svc) return;

  server.registerTool(
    "open_change_campaign",
    {
      annotations: { readOnlyHint: false },
      description:
        'Open the `change` grade of campaign against an issue — the unit every code change belongs to. Name the service being changed and DECLARE THE ACCEPTANCE CRITERIA NOW: a criterion written after the work describes the outcome instead of judging it, and the list is immutable once open. Every criterion says what it JUDGES: `{kind:"requirement", issueId}` answers one thing the request asked for — normally a sub-issue, ONE PER THING ASKED FOR, so "five were asked, two shipped" is a count rather than a sentence in a report; `{kind:"quality"}` judges the change itself (gates, regressions, counterexamples seen red) and is never counted as a requirement. At least one must be a requirement — when the request is atomic, that is the campaign\u2019s own issue. If the request bundles several things, SPLIT IT INTO SUB-ISSUES FIRST (create_issue with parentId) and give each one its own criterion: a criterion that spans several requests can only be answered all-or-nothing, so the ones that did ship disappear into its single not_met. The evaluated grade (open_campaign, a frozen exam over a harness/agent/environment) is the other grade and is untouched by this one.',
      inputSchema: {
        issue_id: z.string().min(1).describe("the request this change serves (id or identifier)"),
        repository: z.string().min(1).max(200).describe("owner/name"),
        path: z
          .string()
          .max(200)
          .optional()
          .describe("the subpath inside a monorepo, when the service is one of several"),
        criteria: z.array(DeclarableCriterionSchema).min(1).max(100),
        continues: z
          .string()
          .min(1)
          .optional()
          .describe("the ENDED campaign this one continues — the remainder of a partial adoption, or a retry"),
        delegation: z
          .object({ required: z.literal(true) })
          .optional()
          .describe(
            "set { required: true } when every round of this campaign is performed by a DELEGATED work agent — a round that names no delegation session is then refused, rather than quietly accepted as a hand-typed one. Declared here and not per round on purpose: who did the work, decided after the work, is an annotation nobody checks.",
          ),
      },
    },
    ({ issue_id, repository, path, criteria, continues, delegation }) =>
      run(principal, "scorecards:run", async () =>
        ok(
          await svc.open(ws, principal.subject, {
            issueId: issue_id,
            service: { repository, ...(path !== undefined ? { path } : {}) },
            criteria,
            ...(continues !== undefined ? { continues } : {}),
            ...(delegation !== undefined ? { delegation } : {}),
          }),
        ),
      ),
  );

  server.registerTool(
    "log_change_round",
    {
      annotations: { readOnlyHint: false },
      description:
        "Append one attempt — and logging it IS closing it, because you decide when the round is done. What it believed, the change set it produced (each service's commits, and the pull request when there is one), and YOUR answer to every criterion this campaign declared — `met` | `not_met` | `not_run`, each marked `observed` (a command ran; name it) or `asserted` (you read the code and concluded). Anything other than `met` carries a `reason` from a closed list, because \"why not\" is the half a reader acts on: `attempted_and_failed` (the work ran and fell short — redo it) · `needs_information` (a repro path, a log, the reporter\u2019s answer) · `needs_environment` (a device, a staging service) · `blocked_elsewhere` (another team, repo or product call) · `descoped` (dropped from THIS campaign). Only the first means \"try again\"; the rest name something to go and get. Carry the repository's gate runs WITH THEIR NUMBERS in `gateRuns`; an `observed` answer must cite one by id, because an observation that names no measurement is an assertion wearing the other word. The round's outcome is DERIVED from the answers and cannot be sent: `not_run` is not `met`. Link the executor checkpoint you published with `checkpoint_id` so the claim's evidence travels with the round. Refused when the answers do not cover the declaration exactly, when a commit is already claimed by another round, or (409) when another round landed while yours was being judged.",
      inputSchema: {
        id: z.string().min(1),
        hypothesis: z.string().min(1).max(2000),
        changes: z.array(ChangeSetEntrySchema).max(50).default([]),
        gateRuns: z.array(GateRunSchema).max(50).default([]),
        answers: z.array(ChangeJudgementAnswerSchema).max(200),
        checkpoint_id: z.string().min(1).optional(),
        learned: z.string().max(4000).optional().describe("what this attempt taught — kept even when it was rejected"),
        delegation_run_id: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe(
            "the sandbox session whose DELEGATE did this round's work. Everdict reads that session's brief and report itself — do not retype them: `changes` and the delegate's gate runs come from the report, and the round records what the delegate answered for EVERY criterion this campaign declared, so a criterion it skipped is a row rather than an absence. `answers` stays YOURS: a delegate whose report became the judgement would be grading its own exam.",
          ),
      },
    },
    ({ id, hypothesis, changes, gateRuns, answers, checkpoint_id, learned, delegation_run_id }) =>
      run(principal, "scorecards:run", async () =>
        ok(
          await svc.logRound(ws, principal.subject, id, {
            hypothesis,
            changes,
            gateRuns,
            answers,
            ...(checkpoint_id !== undefined ? { checkpointId: checkpoint_id } : {}),
            ...(learned !== undefined ? { learned } : {}),
            ...(delegation_run_id !== undefined ? { delegationRunId: delegation_run_id } : {}),
          }),
        ),
      ),
  );

  server.registerTool(
    "close_change_campaign",
    {
      annotations: { readOnlyHint: false },
      description:
        "End the campaign. A request is often satisfied in pieces: `partially_adopted` names what LANDED and what is still owed, and the remainder is picked up by the next campaign naming this one in `continues` — one open campaign per issue. `adopted` names the round that carried it, and that round must be one whose criteria ALL came back met — the platform checks, rather than taking your word for the aggregate. `abandoned` needs the reason it stopped. Neither may close in silence: name the knowledge entries this work produced, or decline with `knowledge_declined` — a refusal someone can read is a decision.",
      inputSchema: {
        id: z.string().min(1),
        state: z.enum(["adopted", "partially_adopted", "abandoned"]),
        reason: z.string().min(1).max(2000),
        round_seq: z.number().int().min(1).optional(),
        landed: z
          .array(z.object({ repository: z.string().min(1), path: z.string().optional() }))
          .max(50)
          .default([])
          .describe("partially_adopted only — the services this campaign actually landed"),
        remaining: z
          .array(z.object({ repository: z.string().min(1), path: z.string().optional() }))
          .max(50)
          .default([])
          .describe("partially_adopted only — what is still owed, for the campaign that continues this one"),
        knowledge: z.array(z.string().min(1)).max(32).default([]),
        knowledge_declined: z.string().max(500).optional(),
      },
    },
    ({ id, state, reason, round_seq, knowledge, knowledge_declined, landed, remaining }) =>
      run(principal, "scorecards:run", async () =>
        ok(
          await svc.close(ws, principal.subject, id, {
            state,
            reason,
            knowledge,
            landed,
            remaining,
            ...(round_seq !== undefined ? { roundSeq: round_seq } : {}),
            ...(knowledge_declined !== undefined ? { knowledgeDeclined: knowledge_declined } : {}),
          }),
        ),
      ),
  );

  server.registerTool(
    "get_change_campaign",
    {
      annotations: { readOnlyHint: true },
      description:
        "One change campaign: the criteria it declared, every round with its change set and answers, and how it ended.",
      inputSchema: { id: z.string().min(1) },
    },
    ({ id }) => run(principal, "scorecards:read", async () => ok(await svc.get(ws, id))),
  );

  server.registerTool(
    "list_change_campaigns",
    {
      annotations: { readOnlyHint: true },
      description:
        "Change campaigns, newest first, as SUMMARY rows — which request, which service, where it ended, what the request is still owed (`requirements`), how many criteria were declared, and `rounds` as a count plus the LATEST round's verdict (its seq, outcome, who judged it and when, and the delegation that produced it when a work agent did). The rounds themselves — hypotheses, change sets, gate metrics, per-criterion answers, what each taught — are one call away on `get_change_campaign`, because nine campaigns returned in full came to 85,793 characters and exceeded a caller's output limit. `available` says how many campaigns matched against how many came back, so a full page and a corpus exactly that size stop reading alike. `issue_id` narrows to one request's attempts.",
      inputSchema: {
        issue_id: z.string().min(1).optional(),
        limit: z.number().int().positive().max(500).optional(),
      },
    },
    ({ issue_id, limit }) =>
      run(principal, "scorecards:read", async () =>
        ok(
          await svc.list(ws, {
            ...(issue_id !== undefined ? { issueId: issue_id } : {}),
            ...(limit !== undefined ? { limit } : {}),
          }),
        ),
      ),
  );
}
