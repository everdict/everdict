import { ScorecardResponseSchema } from "@everdict/contracts/wire";
import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { RunExperimentBodySchema, ScoreGroupBodySchema } from "./request/run-experiment.js";

const groupIdParams = toJsonSchema(z.object({ id: z.string().describe("Group id (a ScorecardRecord id)") }));

// OpenAPI descriptors for the run-group routes (documentation only — no-op compilers; rule api-layer).
// A group IS a ScorecardRecord (execution-model.md P1, decision O3: generalize in concept, keep the table) —
// /groups is the kind-aware surface over it. Authz reuses the scorecard actions (no new action).
const docs = {
  submit: {
    summary: "Run an experiment (ungraded phase-1 group)",
    description:
      "Async ungraded fan-out (execution-model.md P1): drive a harness over a registered dataset (graders " +
      "stripped for this group) or a one-off `task` prompt, N times via `trials` — no judges, no verdict, " +
      "no leaderboard/trend presence; the child runs and their trajectories are the product. Returns 202 " +
      'with the queued record (kind:"experiment"); poll GET /groups/:id (or /scorecards/:id — same record). ' +
      "An ad-hoc task experiment is not re-drivable after a control-plane restart (no registry entry to " +
      "re-plan from). Requires scorecards:run (member+).",
    tags: ["group"],
    body: toJsonSchema(RunExperimentBodySchema),
    response: {
      202: { description: "Experiment accepted (queued)", ...toJsonSchema(ScorecardResponseSchema) },
      ...errorResponses(400, 401, 402, 403, 404, 429),
    },
  },
  score: {
    summary: "Score a group's runs (phase 2, detached)",
    description:
      "Apply the selected judges over an EXISTING group's runs and re-write the aggregate (execution-model.md " +
      "P2): phase 1 is never re-executed — judge verdicts attach to the child runs, the fresh summary to the " +
      "group, and a scorecard.scored platform fact records the pass. Re-scoring a judge REPLACES its previous " +
      "verdicts (idempotent by judge:<id>); scoring an EXPERIMENT promotes it to a scorecard (kind flips). " +
      "Async: returns 202 with the still-unchanged record — poll GET /groups/:id until summary/judgeModels " +
      "move. 409 when the group is not succeeded or a scoring pass is already in flight; 400 when it has no " +
      "case results. Requires scorecards:run (member+).",
    tags: ["group"],
    params: groupIdParams,
    body: toJsonSchema(ScoreGroupBodySchema),
    response: {
      202: {
        description: "Scoring started (the record is returned as-of submission)",
        ...toJsonSchema(ScorecardResponseSchema),
      },
      ...errorResponses(400, 401, 403, 404, 409),
    },
  },
  get: {
    summary: "Get a run group",
    description:
      "The group record with hydrated detail — identical to GET /scorecards/:id (a group IS a scorecard row; " +
      "kind tells them apart). Workspace-scoped; requires scorecards:read.",
    tags: ["group"],
    params: groupIdParams,
    response: {
      200: { description: "The group record", ...toJsonSchema(ScorecardResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
} satisfies Record<string, FastifySchema>;

// Widened so Fastify does NOT narrow reply.code() to the documented status keys.
export const groupDocs: Record<keyof typeof docs, FastifySchema> = docs;
