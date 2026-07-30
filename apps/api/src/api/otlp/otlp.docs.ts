import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";

// OpenAPI descriptor for the OTLP/HTTP door (documentation only — the handler parses the OTLP JSON itself).
const docs = {
  ingest: {
    summary: "OTLP/HTTP trace ingest (the owned collector's door)",
    description:
      "Standard OTLP/HTTP JSON (ExportTraceServiceRequest) at the standard path — point " +
      "OTEL_EXPORTER_OTLP_ENDPOINT here and pass a tenant API key via OTEL_EXPORTER_OTLP_HEADERS " +
      "(authorization: Bearer ak_…). Spans correlate to the run ledger by the everdict.run_id attribute " +
      "(resource-level from the injected OTEL_RESOURCE_ATTRIBUTES, span-level override wins); each run's " +
      "spans normalize through the same GenAI-convention path the pull sources use and SEAL in the owned " +
      "TrajectoryStore (first write wins — evidence is never rewritten). Spans without a run id or for an " +
      "already-sealed run are rejected visibly via partialSuccess. Requires runs:submit.",
    tags: ["observability"],
    response: {
      200: {
        description:
          "OTLP-spec response — empty on full success, partialSuccess with the rejected span count otherwise",
        ...toJsonSchema(
          z.object({
            partialSuccess: z.object({ rejectedSpans: z.number(), errorMessage: z.string() }).optional(),
          }),
        ),
      },
      ...errorResponses(401, 403, 404),
    },
  },
} satisfies Record<string, FastifySchema>;

export const otlpDocs: Record<keyof typeof docs, FastifySchema> = docs;
