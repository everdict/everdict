import type { FastifyInstance } from "fastify";
import { type ServerDeps, gate, resolvePrincipal, sendError } from "../route-context.js";
import { otlpDocs } from "./otlp.docs.js";

// The OTLP/HTTP door (native-observability N0): standard-path POST /v1/traces, credentialed with the SAME
// Bearer resolution as every route (a tenant API key rides OTEL_EXPORTER_OTLP_HEADERS — dedicated
// ingest-scoped tokens are the N2 refinement). This is a machine PROTOCOL endpoint (an exporter target,
// like /metrics is a scraper target), not a member capability — hence no MCP twin. Spec-shaped response:
// {} on full success, partialSuccess with the rejected span count otherwise (never a silent drop).
export function registerOtlpRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.post("/v1/traces", { schema: otlpDocs.ingest }, async (req, reply) => {
    if (!deps.otlpIngest) return reply.code(404).send({ code: "NOT_FOUND", message: "OTLP ingest not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "runs:submit");
      const { rejectedSpans } = await deps.otlpIngest.ingest(principal.workspace, req.body);
      if (rejectedSpans > 0)
        return reply.send({
          partialSuccess: {
            rejectedSpans,
            errorMessage:
              "spans without an everdict.run_id attribute, or for an already-sealed run, were rejected (evidence is sealed once)",
          },
        });
      return reply.send({});
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
