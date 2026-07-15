import { VersionTagsBodySchema, setVersionTags } from "@everdict/application-control";
import { deleteDatasetVersion, deleteDatasetVersions } from "@everdict/application-control";
import { DatasetSchema } from "@everdict/contracts";
import { diffDatasets, harborToDataset, terminalBenchToDataset } from "@everdict/datasets";
import type { FastifyInstance } from "fastify";
import { type ServerDeps, gate, resolvePrincipal, sendError, zodIssues } from "../route-context.js";
import { datasetDocs } from "./dataset.docs.js";
import { DeleteDatasetVersionsBodySchema } from "./request/delete-dataset-versions.js";
import { ImportHarborBodySchema } from "./request/import-harbor.js";
import { ImportTerminalBenchBodySchema } from "./request/import-terminal-bench.js";

// datasets (workspace-owned SSOT, harness-agnostic eval-case bundles)
export function registerDatasetRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.post("/datasets", { schema: datasetDocs.register }, async (req, reply) => {
    if (!deps.datasetRegistry)
      return reply.code(404).send({ code: "NOT_FOUND", message: "dataset registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "datasets:write");
    } catch (err) {
      return sendError(reply, err); // no permission 403 (gate before validation — don't leak validation info to the unauthorized)
    }
    const parsed = DatasetSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      await deps.datasetRegistry.register(principal.workspace, parsed.data, principal.subject); // creator = subject (delete rights)
      return reply.code(201).send({ workspace: principal.workspace, id: parsed.data.id, version: parsed.data.version });
    } catch (err) {
      return sendError(reply, err); // immutable 409
    }
  });

  // Terminal-Bench task-set → workspace Dataset (standard task-format on-ramp). Same gate as datasets:write. Each task
  // maps to an EvalCase (prebuilt image env + instruction + tests-pass); a task with no resolvable image is a 400
  // (Everdict references images, never builds). Versions are immutable (409 on collision). docs/architecture/standard-task-formats.md
  app.post("/datasets/terminal-bench", { schema: datasetDocs.importTerminalBench }, async (req, reply) => {
    if (!deps.datasetRegistry)
      return reply.code(404).send({ code: "NOT_FOUND", message: "dataset registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "datasets:write");
    } catch (err) {
      return sendError(reply, err); // gate before validation — don't leak validation info to the unauthorized
    }
    const parsed = ImportTerminalBenchBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      const dataset = terminalBenchToDataset(
        parsed.data.tasks,
        {
          id: parsed.data.dataset.id,
          version: parsed.data.dataset.version,
          ...(parsed.data.description ? { description: parsed.data.description } : {}),
          ...(parsed.data.tags ? { tags: parsed.data.tags } : {}),
        },
        parsed.data.imageTemplate ? { imageTemplate: parsed.data.imageTemplate } : {},
      );
      await deps.datasetRegistry.register(principal.workspace, dataset, principal.subject);
      return reply.code(201).send({
        workspace: principal.workspace,
        id: dataset.id,
        version: dataset.version,
        cases: dataset.cases.length,
      });
    } catch (err) {
      return sendError(reply, err); // unresolved image 400 / immutable 409
    }
  });

  // Harbor (Anthropic) task-set → workspace Dataset — same on-ramp as Terminal-Bench (datasets:write, unresolved image 400).
  app.post("/datasets/harbor", { schema: datasetDocs.importHarbor }, async (req, reply) => {
    if (!deps.datasetRegistry)
      return reply.code(404).send({ code: "NOT_FOUND", message: "dataset registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "datasets:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = ImportHarborBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      const dataset = harborToDataset(
        parsed.data.tasks,
        {
          id: parsed.data.dataset.id,
          version: parsed.data.dataset.version,
          ...(parsed.data.description ? { description: parsed.data.description } : {}),
          ...(parsed.data.tags ? { tags: parsed.data.tags } : {}),
        },
        parsed.data.imageTemplate ? { imageTemplate: parsed.data.imageTemplate } : {},
      );
      await deps.datasetRegistry.register(principal.workspace, dataset, principal.subject);
      return reply.code(201).send({
        workspace: principal.workspace,
        id: dataset.id,
        version: dataset.version,
        cases: dataset.cases.length,
      });
    } catch (err) {
      return sendError(reply, err); // unresolved image 400 / immutable 409
    }
  });

  // dry-run validate — schema + this workspace's existing versions/conflict (does not register). Pre-check for the register flow.
  app.post("/datasets/validate", { schema: datasetDocs.validate }, async (req, reply) => {
    if (!deps.datasetRegistry)
      return reply.code(404).send({ code: "NOT_FOUND", message: "dataset registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "datasets:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = DatasetSchema.safeParse(req.body);
    if (!parsed.success)
      return reply.send({ ok: false, errors: zodIssues(parsed.error), existingVersions: [], versionExists: false });
    const existingVersions = await deps.datasetRegistry.ownVersions(principal.workspace, parsed.data.id);
    return reply.send({
      ok: true,
      id: parsed.data.id,
      version: parsed.data.version,
      cases: parsed.data.cases.length,
      existingVersions,
      versionExists: existingVersions.includes(parsed.data.version),
    });
  });

  app.get("/datasets", { schema: datasetDocs.list }, async (req, reply) => {
    if (!deps.datasetRegistry)
      return reply.code(404).send({ code: "NOT_FOUND", message: "dataset registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "datasets:read");
      return reply.send(await deps.datasetRegistry.list(principal.workspace));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Full dataset for a specific version (cases included). version may be "latest". Other workspace → NOT_FOUND.
  app.get<{ Params: { id: string; version: string } }>(
    "/datasets/:id/versions/:version",
    { schema: datasetDocs.get },
    async (req, reply) => {
      if (!deps.datasetRegistry)
        return reply.code(404).send({ code: "NOT_FOUND", message: "dataset registry not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "datasets:read");
        return reply.send(await deps.datasetRegistry.get(principal.workspace, req.params.id, req.params.version));
      } catch (err) {
        return sendError(reply, err); // not found → NotFoundError → 404
      }
    },
  );

  // Soft-delete a dataset version — only that version's own creator or a workspace admin (deleteDatasetVersion gates it).
  // Deletion is a tombstone (data preserved, excluded from reads) → past scorecards stay reproducible. Missing/already-deleted/non-owned version = 404.
  app.delete<{ Params: { id: string; version: string } }>(
    "/datasets/:id/versions/:version",
    { schema: datasetDocs.deleteVersion },
    async (req, reply) => {
      if (!deps.datasetRegistry)
        return reply.code(404).send({ code: "NOT_FOUND", message: "dataset registry not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        return reply.send(
          await deleteDatasetVersion(deps.datasetRegistry, principal, req.params.id, req.params.version),
        );
      } catch (err) {
        return sendError(reply, err); // no permission 403 / not found 404
      }
    },
  );

  // Bulk soft-delete — several selected versions (body `{versions}`) or the whole dataset (body-less = all own live versions).
  // deleteDatasetVersions gates each target creator-or-admin and fails fast (nothing deleted if any is forbidden/absent).
  app.delete<{ Params: { id: string }; Body: { versions?: string[] } }>(
    "/datasets/:id",
    { schema: datasetDocs.deleteVersions },
    async (req, reply) => {
      if (!deps.datasetRegistry)
        return reply.code(404).send({ code: "NOT_FOUND", message: "dataset registry not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      // Body is optional (body-less DELETE = delete all). Only validate when one was sent.
      const parsed = DeleteDatasetVersionsBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
      try {
        return reply.send(
          await deleteDatasetVersions(deps.datasetRegistry, principal, req.params.id, parsed.data.versions),
        );
      } catch (err) {
        return sendError(reply, err); // no permission 403 / not found 404
      }
    },
  );

  // Replace version tags (whole-array PUT; empty array = clear) — mutable metadata outside the spec (free labels, to tell versions apart).
  // Distinct from the content's tags (entity classification). Reuses the datasets:write gate. _shared / other-workspace versions = 404.
  app.put<{ Params: { id: string; version: string } }>(
    "/datasets/:id/versions/:version/tags",
    { schema: datasetDocs.setVersionTags },
    async (req, reply) => {
      if (!deps.datasetRegistry)
        return reply.code(404).send({ code: "NOT_FOUND", message: "dataset registry not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      const parsed = VersionTagsBodySchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
      try {
        return reply.send(
          await setVersionTags(
            deps.datasetRegistry,
            principal,
            "datasets:write",
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

  // Diff between versions — case additions/removals/changes + metadata changes between base↔candidate. Both may be "latest".
  // Immutable-version premise (registry-enforced) → the same (id, version) always has the same content, so the comparison is reproducible.
  app.get<{ Params: { id: string }; Querystring: { base?: string; candidate?: string } }>(
    "/datasets/:id/diff",
    { schema: datasetDocs.diff },
    async (req, reply) => {
      if (!deps.datasetRegistry)
        return reply.code(404).send({ code: "NOT_FOUND", message: "dataset registry not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      const { base, candidate } = req.query;
      if (!base || !candidate)
        return reply
          .code(400)
          .send({ code: "BAD_REQUEST", message: "base and candidate query parameters are required." });
      try {
        gate(principal, "datasets:read");
        const [baseDs, candidateDs] = await Promise.all([
          deps.datasetRegistry.get(principal.workspace, req.params.id, base),
          deps.datasetRegistry.get(principal.workspace, req.params.id, candidate),
        ]);
        return reply.send(diffDatasets(baseDs, candidateDs));
      } catch (err) {
        return sendError(reply, err); // version not found → 404
      }
    },
  );
}
