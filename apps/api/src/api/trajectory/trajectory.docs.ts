import type { FastifySchema } from "fastify";

// The owned trajectory ledger's browse surface (native-observability N1 "look inward"): list the sealed
// evidence, newest first — Settings › Traces' primary tab reads THIS, not a tenant's external platform.
// Detail stays on GET /runs/:id/trajectory (the run is the home).
export const trajectoryDocs: Record<string, FastifySchema> = {
  list: {
    summary: "List the workspace's sealed trajectories (the owned evidence ledger)",
    description:
      "Metas only ({runId, source, eventCount, sealedAt}), newest first, cursor-paginated. source says how the " +
      "evidence arrived: run (our own execution), otlp (the OTLP door), import (materialized pull-ingest). " +
      "Open one via GET /runs/:id/trajectory.",
    tags: ["runs"],
    querystring: {
      type: "object",
      properties: {
        limit: { type: "string", description: "page size (default 50, max 200)" },
        cursor: { type: "string", description: "opaque cursor from the previous page" },
      },
    },
    response: {
      200: { description: "{ items: TrajectoryMeta[], nextCursor? }" },
    },
  },
};
