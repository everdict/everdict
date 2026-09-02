import { EvolutionCampaignRecordSchema, RoundEvidenceSchema } from "@everdict/contracts";
import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { AdoptCampaignBodySchema } from "./request/adopt-campaign.js";
import { BuildCampaignBodySchema } from "./request/build-campaign.js";
import { LogCampaignRoundBodySchema } from "./request/log-campaign-round.js";
import { MergeCampaignBodySchema } from "./request/merge-campaign.js";
import { OpenCampaignBodySchema } from "./request/open-campaign.js";

// OpenAPI descriptors for the evolution-campaign routes (doc-only — never validates/serializes; see
// api/openapi.ts). A campaign is the SETTLEMENT behind the agent-evolve loop: a frame frozen at open, an
// append-only round trace whose verdicts are derived from the production diff, and a close that carries the
// pure adoption gate's answer. Authz reuses the scorecard actions (no new action): read = scorecards:read,
// write = scorecards:run. Design: docs/architecture/evolution-lineage.md (Track D).
export const campaignDocs: Record<
  | "open"
  | "list"
  | "get"
  | "logRound"
  | "decision"
  | "settle"
  | "adoption"
  | "adopt"
  | "merge"
  | "build"
  | "builds"
  | "roundEvidence",
  FastifySchema
> = {
  open: {
    summary: "Open an evolution campaign",
    description:
      "Freeze the campaign frame (subject, scenarios with held-out marked, judges, trials, budget, " +
      "significance, the identity waiver) and record its digest. The frame is immutable from here — " +
      "changing it is a new campaign. The issue is the campaign's journal and must exist.",
    tags: ["campaign"],
    body: toJsonSchema(OpenCampaignBodySchema),
    response: {
      201: { description: "The opened campaign", ...toJsonSchema(EvolutionCampaignRecordSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  list: {
    summary: "List the workspace's campaigns",
    tags: ["campaign"],
    response: {
      200: { description: "Campaigns, newest first", ...toJsonSchema(z.array(EvolutionCampaignRecordSchema)) },
      ...errorResponses(401, 403),
    },
  },
  get: {
    summary: "Read one campaign",
    tags: ["campaign"],
    params: toJsonSchema(z.object({ id: z.string() })),
    response: {
      200: { description: "The campaign", ...toJsonSchema(EvolutionCampaignRecordSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  logRound: {
    summary: "Log a campaign round (verdict derived, never accepted)",
    description:
      "Record one tested hypothesis. The round's verdict is derived from the production scorecard diff — " +
      "trial statistics (Fisher/z + FDR + minDelta as frozen in the frame) and experiment identity — so the " +
      "loop cannot write its own report card. Appending CASes on the round count: a concurrent round " +
      "answers 409, re-read and retry. A round past the frame's own ending — the budget spent, or the " +
      "rejected streak reached — also answers 409: the campaign is over by its own rule, ask the decision " +
      "and settle it. Caller fields are bounded by the record schema (400). Under a frame with a delegation " +
      "budget the round names its sandbox session (delegationRunId) and is refused (409) when the ledger says " +
      "that session ran past the budget. The response carries the pure gate's answer over the new trace.",
    tags: ["campaign"],
    params: toJsonSchema(z.object({ id: z.string() })),
    body: toJsonSchema(LogCampaignRoundBodySchema),
    response: {
      201: { description: "The logged round + the gate's answer" },
      ...errorResponses(400, 401, 403, 404, 409),
    },
  },
  decision: {
    summary: "Ask the adoption gate (pure read)",
    description:
      "The pure gate over the frame and the rounds: adopt (the latest candidate is significantly better " +
      "with zero regressions over a verifiable world) | continue | halt (no_improvement, budget_exhausted, " +
      "or identity_unverified — which refuses adoption but keeps the campaign open).",
    tags: ["campaign"],
    params: toJsonSchema(z.object({ id: z.string() })),
    response: { 200: { description: "The gate's answer" }, ...errorResponses(401, 403, 404) },
  },
  settle: {
    summary: "Settle the campaign per the gate's answer",
    description:
      "Close as adopted (recording the version, the proving scorecard, and any waived identity axes) or as " +
      "the gate's own ending (no_improvement / budget_exhausted). A gate answering continue or " +
      "identity_unverified REFUSES the settle with 409 — the campaign is not done, or the fix is another " +
      "round. First terminal wins; a lost race reads what won.",
    tags: ["campaign"],
    params: toJsonSchema(z.object({ id: z.string() })),
    response: {
      200: { description: "The settled campaign + the gate answer it carries" },
      ...errorResponses(401, 403, 404, 409),
    },
  },

  adoption: {
    summary: "Read the adoption this campaign authorized",
    description:
      "The durable authorization an adopted close wrote, and whether it has been spent. `decided` is the " +
      "state a settle-then-crash lands in — the registration can be re-driven from it rather than lost. " +
      "The operation carries the frame digest, the round that proved the candidate, the exact candidate " +
      "spec digest and the campaign's issue; a registry write claiming this campaign proved its version " +
      "presents exactly this proof. `operation` is null when the campaign authorized nothing — a halted " +
      "close, or one that has not settled yet.",
    tags: ["campaign"],
    params: toJsonSchema(z.object({ id: z.string() })),
    response: {
      200: { description: "The campaign and the adoption it authorized (operation: null when none)" },
      ...errorResponses(401, 403, 404),
    },
  },

  build: {
    summary: "Build a code-evolution candidate image into Everdict's own managed store",
    description:
      "Everdict boots the harness slot's base image, checks out the commit, runs the template's frozen build " +
      "steps, and publishes the result as one layer in the managed registry — no outside CI, no Dockerfile " +
      "builder. The commit (ref/repo/prNumber) is the caller's; where the code lives and how it builds are the " +
      "template's `source` + `build` recipe. Returns the `building` record; the build runs in the background and " +
      "settles `built` (with the minted candidate version) or `failed`, emitting campaign.candidate_built.",
    tags: ["campaign"],
    params: toJsonSchema(z.object({ id: z.string() })),
    body: toJsonSchema(BuildCampaignBodySchema),
    response: { 202: { description: "The building record" }, ...errorResponses(400, 401, 403, 404) },
  },
  roundEvidence: {
    summary: "The evidence a round sealed",
    description:
      "The platform-derived record of what one round saw — per compared case: held-out / target flags, both sides' " +
      "pass rates and trials, the per-case verdict (improved · regressed · unchanged · unclear), and the run ids to " +
      "read its traces from — served from the immutable object the round names by key + digest, and refused (409) " +
      "when the stored bytes no longer digest to what the round sealed. A round logged before the record existed " +
      "is 404. Requires scorecards:read.",
    tags: ["campaign"],
    params: toJsonSchema(z.object({ id: z.string(), seq: z.string() })),
    response: {
      200: { description: "The round's evidence record", ...toJsonSchema(RoundEvidenceSchema) },
      ...errorResponses(401, 403, 404, 409),
    },
  },
  builds: {
    summary: "The candidate images this campaign built",
    description:
      "Everdict's own build ledger for the campaign — each build's commit, image, minted version and receipt.",
    tags: ["campaign"],
    params: toJsonSchema(z.object({ id: z.string() })),
    response: { 200: { description: "The campaign's builds" }, ...errorResponses(401, 403, 404) },
  },
  merge: {
    summary: "Pay the adoption's code debt — merge the pull request the adopted bytes were built from",
    description:
      "Present the proof the settle recorded. When the adopted candidate's scorecard named a pull request, the " +
      "close recorded a code debt on the operation (repository, pull request, the head the round measured); " +
      "this merges that pull request through the workspace GitHub App, asserting the head when it is known, " +
      "and records the merge commit. Requires the bytes to be registered first (adopt), refuses a proof that " +
      "is not the recorded one, and converges on a retry (already_merged). A chain cannot continue from an " +
      "adoption whose code debt is still owed.",
    tags: ["campaign"],
    params: toJsonSchema(z.object({ id: z.string() })),
    body: toJsonSchema(MergeCampaignBodySchema),
    response: {
      200: { description: "The paid code debt: the merge commit and the operation" },
      ...errorResponses(400, 401, 403, 404, 409),
    },
  },
  adopt: {
    summary: "Spend the campaign's adoption authorization on a registry write",
    description:
      "Present the proof the settle recorded and the spec being registered. The proof is compared as a " +
      "digest against the stored operation, which binds every coordinate it carries (a structurally-equal " +
      "proof the campaign never issued is not authority, and an edited one is not the recorded one). The " +
      "spec's own id and version are compared against the authorized ones, it is registered at the " +
      "authorized version (immutable versions make identical bytes an idempotent no-op and different bytes " +
      "a conflict), and what the registry then RESOLVES is digested and checked against what the campaign " +
      "measured. Only then is the authorization spent, and it is spendable once: a retry of the same " +
      "adoption converges rather than granting a second one. A mismatch leaves the operation `decided` — " +
      "the registration happened, the claim that this campaign proved it did not.",
    tags: ["campaign"],
    params: toJsonSchema(z.object({ id: z.string() })),
    body: toJsonSchema(AdoptCampaignBodySchema),
    response: {
      200: { description: "The spent authorization and the version that landed" },
      ...errorResponses(400, 401, 403, 404, 409),
    },
  },
};
