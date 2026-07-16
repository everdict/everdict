import { VersionTagsBodySchema, setVersionTags } from "@everdict/application-control";
import { JudgeSpecSchema } from "@everdict/contracts";
import { diffJudgeSpecs } from "@everdict/domain";
import type { FastifyInstance } from "fastify";
import { type ServerDeps, gate, resolvePrincipal, sendError, zodIssues } from "../route-context.js";
import { judgeDocs } from "./judge.docs.js";
import { PreviewJudgeBodySchema } from "./request/judge-evidence.js";

// judges (workspace-owned SSOT, Agent Judge: model | harness)
export function registerJudgeRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.post("/judges", { schema: judgeDocs.register }, async (req, reply) => {
    if (!deps.judgeRegistry)
      return reply.code(404).send({ code: "NOT_FOUND", message: "judge registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "judges:write");
    } catch (err) {
      return sendError(reply, err); // no permission 403 (gate before validation)
    }
    const parsed = JudgeSpecSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      await deps.judgeRegistry.register(principal.workspace, parsed.data, principal.subject);
      return reply.code(201).send({ workspace: principal.workspace, id: parsed.data.id, version: parsed.data.version });
    } catch (err) {
      return sendError(reply, err); // immutable 409
    }
  });

  // dry-run validate — schema + this workspace's existing versions/conflict (does not register).
  app.post("/judges/validate", { schema: judgeDocs.validate }, async (req, reply) => {
    if (!deps.judgeRegistry)
      return reply.code(404).send({ code: "NOT_FOUND", message: "judge registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "judges:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = JudgeSpecSchema.safeParse(req.body);
    if (!parsed.success)
      return reply.send({ ok: false, errors: zodIssues(parsed.error), existingVersions: [], versionExists: false });
    const existingVersions = await deps.judgeRegistry.ownVersions(principal.workspace, parsed.data.id);
    return reply.send({
      ok: true,
      kind: parsed.data.kind,
      id: parsed.data.id,
      version: parsed.data.version,
      existingVersions,
      versionExists: existingVersions.includes(parsed.data.version),
    });
  });

  // Preview — render the exact judging prompt + per-placeholder evidence coverage for a (draft) judge against
  // sample evidence. NO model call (judges:read). The registration wizard calls this live as the user edits.
  app.post("/judges/preview", { schema: judgeDocs.preview }, async (req, reply) => {
    if (!deps.judgePreviewService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "judge preview not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "judges:read");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = PreviewJudgeBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      return reply.send(
        await deps.judgePreviewService.preview({
          tenant: principal.workspace,
          spec: parsed.data.spec,
          evidence: parsed.data.evidence,
        }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/judges", { schema: judgeDocs.list }, async (req, reply) => {
    if (!deps.judgeRegistry)
      return reply.code(404).send({ code: "NOT_FOUND", message: "judge registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "judges:read");
      return reply.send(await deps.judgeRegistry.list(principal.workspace));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Full JudgeSpec for a specific version. version may be "latest". Other workspace → NOT_FOUND.
  app.get<{ Params: { id: string; version: string } }>(
    "/judges/:id/versions/:version",
    { schema: judgeDocs.get },
    async (req, reply) => {
      if (!deps.judgeRegistry)
        return reply.code(404).send({ code: "NOT_FOUND", message: "judge registry not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "judges:read");
        return reply.send(await deps.judgeRegistry.get(principal.workspace, req.params.id, req.params.version));
      } catch (err) {
        return sendError(reply, err); // not found → NotFoundError → 404
      }
    },
  );

  // Structural field-level diff between two judge versions (base ↔ candidate). Both refs may be "latest".
  // Immutable-version premise → reproducible. Static "diff" segment resolves ahead of ":id/versions/:version".
  app.get<{ Params: { id: string }; Querystring: { base?: string; candidate?: string } }>(
    "/judges/:id/diff",
    { schema: judgeDocs.diff },
    async (req, reply) => {
      if (!deps.judgeRegistry)
        return reply.code(404).send({ code: "NOT_FOUND", message: "judge registry not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      const { base, candidate } = req.query;
      if (!base || !candidate)
        return reply
          .code(400)
          .send({ code: "BAD_REQUEST", message: "base and candidate query parameters are required." });
      try {
        gate(principal, "judges:read");
        const [baseSpec, candidateSpec] = await Promise.all([
          deps.judgeRegistry.get(principal.workspace, req.params.id, base),
          deps.judgeRegistry.get(principal.workspace, req.params.id, candidate),
        ]);
        return reply.send(diffJudgeSpecs(baseSpec, candidateSpec));
      } catch (err) {
        return sendError(reply, err); // version not found / other workspace → 404
      }
    },
  );

  // Replace version tags (whole-array PUT; empty array = clear) — mutable metadata outside the spec (free labels, to tell versions apart). Reuses judges:write.
  app.put<{ Params: { id: string; version: string } }>(
    "/judges/:id/versions/:version/tags",
    { schema: judgeDocs.setVersionTags },
    async (req, reply) => {
      if (!deps.judgeRegistry)
        return reply.code(404).send({ code: "NOT_FOUND", message: "judge registry not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      const parsed = VersionTagsBodySchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
      try {
        return reply.send(
          await setVersionTags(
            deps.judgeRegistry,
            principal,
            "judges:write",
            req.params.id,
            req.params.version,
            parsed.data.tags,
          ),
        );
      } catch (err) {
        return sendError(reply, err); // no permission 403 / not found·non-owned 404
      }
    },
  );
}
