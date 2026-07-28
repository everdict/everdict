import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type ServerDeps, gate, resolvePrincipal, sendError } from "../route-context.js";
import { fsDocs } from "./fs.docs.js";
import { MakeFsDirectoryBodySchema } from "./request/make-fs-directory.js";
import { MoveFsEntryBodySchema } from "./request/move-fs-entry.js";
import { WriteFsFileBodySchema } from "./request/write-fs-file.js";

const ListQuerySchema = z.object({ path: z.string().max(600).optional() });
const FileQuerySchema = z.object({ path: z.string().min(1).max(600) });
const RemoveQuerySchema = z.object({
  path: z.string().min(1).max(600),
  recursive: z.enum(["true", "false"]).optional(),
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
      return reply.send(await deps.fsService.writeFile(principal.workspace, parsed.data));
    } catch (err) {
      return sendError(reply, err); // over a dir → 409, oversized/traversal → 400
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
