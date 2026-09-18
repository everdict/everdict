import { knowledgeSeedDigest } from "@everdict/domain";
import type { FastifyInstance } from "fastify";
import { type ServerDeps, gate, resolvePrincipal, sendError, zodIssues } from "../route-context.js";
import {
  AssembleContextBodySchema,
  CreateKnowledgeEntryBodySchema,
  RecordRetrievalUseBodySchema,
  UpdateKnowledgeEntryBodySchema,
} from "./request/knowledge-entry-write.js";
import { ExtractKnowledgeBodySchema } from "./request/knowledge-extract.js";

// Workspace knowledge — task-context assembly over the knowledge entries and skills ABOUT a task's anchors, the entry
// library (reified claims: CRUD, verify, review), and thread extraction. Reads = scorecards:read; member
// contributions = comments:write. See docs/architecture/workspace-knowledge.md.
export function registerKnowledgeRoutes(app: FastifyInstance, deps: ServerDeps): void {
  // Task-time context assembly — the knowledge entries and skill candidates ABOUT the anchors, each positioned on the
  // anchor's version coordinate and freshness-decorated. POST because anchors are structured NodeRefs (keys may
  // contain '/' / ':').
  // The session's account of what it USED, beside the assembly's own file. An HTTP caller has no MCP session,
  // so the correlator is read from the assembly path it names rather than invented here.
  app.post("/knowledge/context/use", async (req, reply) => {
    if (!deps.knowledgeService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "knowledge service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      // AUTHORIZE, THEN PARSE (rule `api-layer`, the fixed handler shape). `gate` reads nothing from the body,
      // so parsing first only tells a caller who may not use this door which fields their request got wrong.
      gate(principal, "scorecards:read");
      const parsed = RecordRetrievalUseBodySchema.safeParse(req.body);
      if (!parsed.success)
        return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(parsed.error).join("; ") });
      return reply.send(
        await deps.knowledgeService.recordUse(principal.workspace, principal.subject, {
          sessionId: parsed.data.assemblyPath.split("/").at(-2) ?? "unattributed",
          assemblyPath: parsed.data.assemblyPath,
          used: parsed.data.used,
          outcome: parsed.data.outcome,
        }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/knowledge/context", async (req, reply) => {
    if (!deps.knowledgeService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "knowledge service not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "scorecards:read");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = AssembleContextBodySchema.safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(parsed.error).join("; ") });
    try {
      return reply.send(
        // Same projection as the MCP surface, for the same measured reason: this read is agent-facing and its
        // full-body form overflowed a caller at 20 entries. The body is one `GET /knowledge/entries/:id` away.
        await deps.knowledgeService.assembleContext(
          principal.workspace,
          principal.subject,
          parsed.data.refs,
          undefined,
          { body: "omit", ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}) },
        ),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // --- knowledge entries: reified claims ---
  // Reads = scorecards:read (like every knowledge read); writes = comments:write (a member contribution); manage
  // (edit/delete/verify) additionally gates creator-or-admin in the service.

  app.post("/knowledge/entries", async (req, reply) => {
    if (!deps.knowledgeEntryService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "knowledge entries not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "comments:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = CreateKnowledgeEntryBodySchema.safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(parsed.error).join("; ") });
    try {
      return reply.code(201).send(
        await deps.knowledgeEntryService.create({
          tenant: principal.workspace,
          createdBy: principal.subject,
          ...parsed.data,
        }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/knowledge/entries", async (req, reply) => {
    if (!deps.knowledgeEntryService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "knowledge entries not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "scorecards:read");
      return reply.send(await deps.knowledgeEntryService.list(principal.workspace, principal.subject));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/knowledge/entries/:id", async (req, reply) => {
    if (!deps.knowledgeEntryService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "knowledge entries not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "scorecards:read");
      const entry = await deps.knowledgeEntryService.get(principal.workspace, req.params.id, principal.subject);
      // …with the digest a harness version names to SEED this entry (harness-identity-and-seeds-spec.md §2).
      return reply.send({ ...entry, seedDigest: knowledgeSeedDigest(entry) });
    } catch (err) {
      return sendError(reply, err); // foreign private / missing → 404
    }
  });

  app.patch<{ Params: { id: string } }>("/knowledge/entries/:id", async (req, reply) => {
    if (!deps.knowledgeEntryService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "knowledge entries not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "comments:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = UpdateKnowledgeEntryBodySchema.safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(parsed.error).join("; ") });
    try {
      return reply.send(
        await deps.knowledgeEntryService.update(principal.workspace, req.params.id, parsed.data, {
          subject: principal.subject,
          isAdmin: principal.roles.includes("admin"),
        }),
      );
    } catch (err) {
      return sendError(reply, err); // creator-or-admin gate → 403/404
    }
  });

  app.delete<{ Params: { id: string } }>("/knowledge/entries/:id", async (req, reply) => {
    if (!deps.knowledgeEntryService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "knowledge entries not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "comments:write");
      await deps.knowledgeEntryService.remove(principal.workspace, req.params.id, {
        subject: principal.subject,
        isAdmin: principal.roles.includes("admin"),
      });
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Attest a claim still holds — stamps verifiedAt without touching updatedAt (the freshness baseline).
  app.post<{ Params: { id: string } }>("/knowledge/entries/:id/verify", async (req, reply) => {
    if (!deps.knowledgeEntryService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "knowledge entries not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "comments:write");
      return reply.send(
        await deps.knowledgeEntryService.verify(principal.workspace, req.params.id, {
          subject: principal.subject,
          isAdmin: principal.roles.includes("admin"),
        }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Mine a discussion thread for knowledge-entry candidates → `proposed` entries awaiting review. member+ (a real
  // billable model call, like skill-generate).
  app.post("/knowledge/extract", async (req, reply) => {
    if (!deps.knowledgeExtraction)
      return reply.code(404).send({ code: "NOT_FOUND", message: "knowledge extraction not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "comments:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = ExtractKnowledgeBodySchema.safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({ code: "BAD_REQUEST", message: zodIssues(parsed.error).join("; ") });
    try {
      return reply.send(await deps.knowledgeExtraction.extract(principal.workspace, principal.subject, parsed.data));
    } catch (err) {
      return sendError(reply, err); // unknown thread/model 404 · missing key 400 · upstream 502
    }
  });

  // Approve a proposal — the HITL promotion: proposed → active, authorship transfers to the approver. member+.
  app.post<{ Params: { id: string } }>("/knowledge/entries/:id/approve", async (req, reply) => {
    if (!deps.knowledgeEntryService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "knowledge entries not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "comments:write");
      return reply.send(
        await deps.knowledgeEntryService.approve(principal.workspace, req.params.id, {
          subject: principal.subject,
          isAdmin: principal.roles.includes("admin"),
        }),
      );
    } catch (err) {
      return sendError(reply, err); // non-proposed → 409
    }
  });

  // Reject a proposal — deletes it (only `proposed` entries; an active claim goes through the gated DELETE). member+.
  app.post<{ Params: { id: string } }>("/knowledge/entries/:id/reject", async (req, reply) => {
    if (!deps.knowledgeEntryService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "knowledge entries not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "comments:write");
      await deps.knowledgeEntryService.reject(principal.workspace, req.params.id);
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err); // non-proposed → 409
    }
  });
}
