import type { FastifySchema } from "fastify";
import { BundleSchema } from "../../core/bundle/bundle-service.js";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { BundleApplyResultSchema } from "./response/bundle-apply-result.js";

// OpenAPI descriptors for the bundle routes — doc-only (rule api-layer): the no-op compilers in server.ts
// make attaching these behavior-free; validation stays in the handlers.

const docs = {
  apply: {
    summary: "Apply a bundle (one-shot register)",
    description:
      "Fans a single manifest out to the per-type registries (harness templates + instances, benchmark recipes, " +
      "datasets, judges, models, runtimes) — idempotent with partial success (per-item ok/conflict/error/skipped; " +
      "the batch never aborts and item conflicts do not produce an HTTP 409). AuthZ composes the per-type gates " +
      "derived from the bundle contents (templates:write / harnesses:register [viewer+], datasets:write / " +
      "judges:write / models:write [member+], runtimes:write [viewer+]) — no dedicated bundle action; any missing " +
      "gate is 403.",
    tags: ["bundle"],
    body: toJsonSchema(BundleSchema),
    response: {
      200: { description: "Per-item fan-out results", ...toJsonSchema(BundleApplyResultSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
} satisfies Record<string, FastifySchema>;

// Widened re-export (team convention): the descriptors' literal response keys would otherwise make Fastify
// narrow reply.code() in the handlers — the FastifySchema value type keeps the doc attachment behavior-free.
export const bundleDocs: Record<keyof typeof docs, FastifySchema> = docs;
