import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type ServerDeps, gate, resolvePrincipal, sendError } from "../route-context.js";
import { agentAttributionFrom, fsActorFor } from "./fs-actor.js";
import { fsDocs } from "./fs.docs.js";
import { MakeFsDirectoryBodySchema } from "./request/make-fs-directory.js";
import { MoveFsEntryBodySchema } from "./request/move-fs-entry.js";
import { RestoreFsRevisionBodySchema } from "./request/restore-fs-revision.js";
import { WriteFsFileBodySchema } from "./request/write-fs-file.js";

const ListQuerySchema = z.object({ path: z.string().max(600).optional() });
const FileQuerySchema = z.object({ path: z.string().min(1).max(600) });
const RemoveQuerySchema = z.object({
  path: z.string().min(1).max(600),
  recursive: z.enum(["true", "false"]).optional(),
});
// Query params arrive as strings — coerced after parsing, like the `recursive` flag above.
const RevisionListQuerySchema = z.object({
  path: z.string().min(1).max(600),
  limit: z
    .string()
    .regex(/^\d{1,3}$/)
    .optional(),
});
const RevisionContentQuerySchema = z.object({
  path: z.string().min(1).max(600),
  revision: z.string().regex(/^\d{1,9}$/),
});

// The workspace filesystem — a shared, workspace-isolated file tree (agent task outputs, artifacts, skill/knowledge
// bodies) browsed shell-style from the web and read/written by agents over MCP. Paths travel as query params/body
// fields (they contain '/'); the filesystem normalizes them and rejects traversal. Read = files:read (viewer+);
// any mutation = files:write (member+).
export function registerFsRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get("/fs/entries", { schema: fsDocs.list }, async (req, reply) => {
    if (!deps.fsService) return reply.code(404).send({ code: "NOT_FOUND", message: "filesystem not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "files:read");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = ListQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      return reply.send(await deps.fsService.list(principal.workspace, parsed.data.path));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/fs/file", { schema: fsDocs.read }, async (req, reply) => {
    if (!deps.fsService) return reply.code(404).send({ code: "NOT_FOUND", message: "filesystem not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "files:read");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = FileQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      return reply.send(await deps.fsService.readFile(principal.workspace, parsed.data.path));
    } catch (err) {
      return sendError(reply, err); // missing → 404, a directory → 400
    }
  });

  app.put("/fs/file", { schema: fsDocs.write }, async (req, reply) => {
    if (!deps.fsService) return reply.code(404).send({ code: "NOT_FOUND", message: "filesystem not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "files:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = WriteFsFileBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      const actor = fsActorFor(principal, agentAttributionFrom(req.headers));
      return reply.send(await deps.fsService.writeFile(principal.workspace, parsed.data, actor));
    } catch (err) {
      return sendError(reply, err); // over a dir / lost race → 409 (+ the merge kit), oversized/traversal → 400
    }
  });

  // The file's publication history — who published each revision, when, and why. Read-gated like any browse.
  app.get("/fs/revisions", { schema: fsDocs.revisions }, async (req, reply) => {
    if (!deps.fsService) return reply.code(404).send({ code: "NOT_FOUND", message: "filesystem not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "files:read");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = RevisionListQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      const limit = parsed.data.limit !== undefined ? Number(parsed.data.limit) : undefined;
      return reply.send(await deps.fsService.history(principal.workspace, parsed.data.path, limit));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // One past revision's content — previewing it, or diffing it against what is live now.
  app.get("/fs/revisions/content", { schema: fsDocs.revisionContent }, async (req, reply) => {
    if (!deps.fsService) return reply.code(404).send({ code: "NOT_FOUND", message: "filesystem not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "files:read");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = RevisionContentQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      return reply.send(
        await deps.fsService.readRevision(principal.workspace, parsed.data.path, Number(parsed.data.revision)),
      );
    } catch (err) {
      return sendError(reply, err); // unknown revision → 404
    }
  });

  // Restore = publish the old bytes as a NEW revision, attributed to whoever pressed it. History is append-only.
  app.post("/fs/revisions/restore", { schema: fsDocs.restore }, async (req, reply) => {
    if (!deps.fsService) return reply.code(404).send({ code: "NOT_FOUND", message: "filesystem not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "files:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = RestoreFsRevisionBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      const actor = fsActorFor(principal, agentAttributionFrom(req.headers));
      return reply.send(
        await deps.fsService.restoreRevision(principal.workspace, parsed.data.path, parsed.data.revision, actor),
      );
    } catch (err) {
      return sendError(reply, err); // unknown revision → 404
    }
  });

  app.post("/fs/directories", { schema: fsDocs.mkdir }, async (req, reply) => {
    if (!deps.fsService) return reply.code(404).send({ code: "NOT_FOUND", message: "filesystem not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "files:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = MakeFsDirectoryBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      return reply.send(await deps.fsService.makeDirectory(principal.workspace, parsed.data.path));
    } catch (err) {
      return sendError(reply, err); // a file at the path → 409
    }
  });

  app.post("/fs/move", { schema: fsDocs.move }, async (req, reply) => {
    if (!deps.fsService) return reply.code(404).send({ code: "NOT_FOUND", message: "filesystem not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "files:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = MoveFsEntryBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      return reply.send(await deps.fsService.move(principal.workspace, parsed.data.from, parsed.data.to));
    } catch (err) {
      return sendError(reply, err); // missing source → 404, occupied target → 409, self-nesting → 400
    }
  });

  app.get("/fs/usage", { schema: fsDocs.usage }, async (req, reply) => {
    if (!deps.fsService) return reply.code(404).send({ code: "NOT_FOUND", message: "filesystem not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "files:read");
      return reply.send(await deps.fsService.usage(principal.workspace));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Empty the whole tree — governance, not content mutation: settings:write (admin), like the knowledge reindex.
  app.delete("/fs", { schema: fsDocs.clear }, async (req, reply) => {
    if (!deps.fsService) return reply.code(404).send({ code: "NOT_FOUND", message: "filesystem not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "settings:write");
      return reply.send(await deps.fsService.clear(principal.workspace));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete("/fs/entry", { schema: fsDocs.remove }, async (req, reply) => {
    if (!deps.fsService) return reply.code(404).send({ code: "NOT_FOUND", message: "filesystem not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "files:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = RemoveQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      return reply.send(
        await deps.fsService.remove(principal.workspace, parsed.data.path, parsed.data.recursive === "true"),
      );
    } catch (err) {
      return sendError(reply, err); // missing → 404, non-empty without recursive → 409
    }
  });
}
