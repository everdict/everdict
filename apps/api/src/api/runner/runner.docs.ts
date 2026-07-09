import type { FastifySchema } from "fastify";
import { z } from "zod";
import { PairRunnerBodySchema } from "../../core/runner/runner-service.js";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { PairedRunnerResponseSchema } from "./response/paired-runner.js";
import { RunnerRosterSchema } from "./response/runner-roster.js";

// Doc-only OpenAPI descriptors for personal self-hosted runners (rule api-layer: schemas document,
// never validate/serialize — the compilers are no-ops).
// Values are widened to FastifySchema so Fastify does NOT narrow reply.code() to the documented status keys.
const docs = {
  list: {
    summary: "List my self-hosted runners",
    description:
      "Personal device pairing — self-scoped like profile/connections, no role gate: only the caller's own " +
      "runners are listed (owner = the authenticated subject). Metadata only, never tokens. A member targets " +
      'their runner by swapping the run\'s runtime to "self:<id>" (or the "self" pool). ' +
      "Design: docs/architecture/self-hosted-runner.md.",
    tags: ["runner"],
    response: {
      200: { description: "The caller's runners", ...toJsonSchema(RunnerRosterSchema) },
      ...errorResponses(401, 404),
    },
  },
  pair: {
    summary: "Pair a personal runner",
    description:
      "Registers the caller's own machine (owner = subject; the workspace is recorded for roster visibility). " +
      "The plaintext rnr_ token appears in this response exactly once and is stored only as a hash — the " +
      "`everdict runner` process authenticates with it. Runs on a personal runner are own-pays (the machine's " +
      "existing login), not workspace budget. Self-scoped, no role gate.",
    tags: ["runner"],
    body: toJsonSchema(PairRunnerBodySchema),
    response: {
      200: { description: "Runner metadata + one-time pairing token", ...toJsonSchema(PairedRunnerResponseSchema) },
      ...errorResponses(400, 401, 404),
    },
  },
  revoke: {
    summary: "Revoke a personal runner",
    description:
      "Removes the pairing (idempotent). Owner-scoped — only the caller's own runners can be revoked; no role gate.",
    tags: ["runner"],
    params: toJsonSchema(z.object({ id: z.string().describe("Runner id") })),
    response: { 204: { description: "Revoked", type: "null" }, ...errorResponses(401, 404) },
  },
} satisfies Record<string, FastifySchema>;

export const runnerDocs: Record<keyof typeof docs, FastifySchema> = docs;
