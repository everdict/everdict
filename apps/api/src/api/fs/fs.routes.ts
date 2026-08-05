import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type ServerDeps, gate, resolvePrincipal, sendError } from "../route-context.js";
import { agentAttributionFrom, fsActorFor } from "./fs-actor.js";
import { fsDocs } from "./fs.docs.js";
import { MakeFsDirectoryBodySchema } from "./request/make-fs-directory.js";
import { MoveFsEntryBodySchema } from "./request/move-fs-entry.js";
import { RestoreFsRevisionBodySchema } from "./request/restore-fs-revision.js";
import { RunFsFileBodySchema } from "./request/run-fs-file.js";
import { WriteFsFileBodySchema } from "./request/write-fs-file.js";

const ListQuerySchema = z.object({ path: z.string().max(600).optional() });
const FileQuerySchema = z.object({ path: z.string().min(1).max(600) });
const SearchQuerySchema = z.object({
  pattern: z.string().min(1).max(300).optional(), // case-insensitive content regex
  glob: z.string().min(1).max(300).optional(), // path pattern (* ? **)
  path: z.string().max(600).optional(), // subtree to search
  limit: z
    .string()
    .regex(/^\d{1,3}$/)
    .optional(),
});
const RemoveQuerySchema = z.object({
  path: z.string().min(1).max(600),
  recursive: z.enum(["true", "false"]).optional(),
});
// Query params arrive as strings — coerced after parsing, like the `recursive` flag above.
const REVISION_NUMBER = /^\d{1,9}$/;
const RevisionListQuerySchema = z.object({
  path: z.string().min(1).max(600),
  limit: z
    .string()
    .regex(/^\d{1,3}$/)
    .optional(),
  before: z.string().regex(REVISION_NUMBER).optional(), // keyset cursor: the oldest revision of the page you have
});
const RevisionContentQuerySchema = z.object({
  path: z.string().min(1).max(600),
  revision: z.string().regex(REVISION_NUMBER),
});
const RevisionDiffQuerySchema = z.object({
  path: z.string().min(1).max(600),
  from: z.string().regex(REVISION_NUMBER),
  to: z.string().regex(REVISION_NUMBER).optional(), // omitted = compare against the live file
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

  app.get("/fs/search", { schema: fsDocs.search }, async (req, reply) => {
    if (!deps.fsService) return reply.code(404).send({ code: "NOT_FOUND", message: "filesystem not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "files:read");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = SearchQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    const { pattern, glob, path, limit } = parsed.data;
    try {
      return reply.send(
        await deps.fsService.search(principal.workspace, {
          ...(pattern !== undefined ? { pattern } : {}),
          ...(glob !== undefined ? { glob } : {}),
          ...(path !== undefined ? { path } : {}),
          ...(limit !== undefined ? { limit: Number(limit) } : {}),
        }),
      );
    } catch (err) {
      return sendError(reply, err); // neither pattern nor glob, or a bad regex → 400
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
      const before = parsed.data.before !== undefined ? Number(parsed.data.before) : undefined;
      return reply.send(await deps.fsService.history(principal.workspace, parsed.data.path, limit, before));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // What changed between two revisions — the history panel's "compare" (omit `to` to compare against the live file).
  app.get("/fs/revisions/diff", { schema: fsDocs.revisionDiff }, async (req, reply) => {
    if (!deps.fsService) return reply.code(404).send({ code: "NOT_FOUND", message: "filesystem not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "files:read");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = RevisionDiffQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      return reply.send(
        await deps.fsService.diffRevisions(
          principal.workspace,
          parsed.data.path,
          Number(parsed.data.from),
          parsed.data.to !== undefined ? Number(parsed.data.to) : undefined,
        ),
      );
    } catch (err) {
      return sendError(reply, err); // unknown revision / missing file → 404
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

  // Run a file. Separate from the eval spine on purpose: no harness, no grading, no run record — a person is
  // reading a script and wants to see what it does. 404 when no execution driver is composed, because "run it on
  // the control-plane host" is not a fallback: without a sandbox the capability simply does not exist here.
  app.post("/fs/executions", { schema: fsDocs.run }, async (req, reply) => {
    if (!deps.fileExecutionService) {
      return reply.code(404).send({ code: "NOT_FOUND", message: "file execution not configured" });
    }
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "files:write"); // a run publishes whatever the script produced — that is a write
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = RunFsFileBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      const actor = fsActorFor(principal, agentAttributionFrom(req.headers));
      return reply.send(await deps.fileExecutionService.run(principal.workspace, parsed.data, actor));
    } catch (err) {
      return sendError(reply, err); // no interpreter / not text → 400, missing file → 404, sandbox fault → 500
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
