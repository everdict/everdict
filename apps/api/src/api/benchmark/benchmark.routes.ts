import { BenchmarkAdapterSpecSchema } from "@everdict/datasets";
import type { FastifyInstance } from "fastify";
import { BenchmarkImportBodySchema, BenchmarkPreviewBodySchema } from "../../core/benchmark/benchmark-service.js";
import { type ServerDeps, gate, resolvePrincipal, sendError, zodIssues } from "../route-context.js";
import { benchmarkDocs } from "./benchmark.docs.js";

// benchmarks (first-party catalog → ingest into tenant-owned datasets; user self-serve) + benchmark-recipes
export function registerBenchmarkRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get("/benchmarks", { schema: benchmarkDocs.list }, async (req, reply) => {
    if (!deps.benchmarkService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "benchmark catalog not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "datasets:read");
      return reply.send(deps.benchmarkService.list());
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // HF Hub dataset search — the wizard picks candidates by query (avoids typing an exact id). Discovery → viewer+.
  app.get("/benchmarks/hf/datasets", { schema: benchmarkDocs.hfDatasets }, async (req, reply) => {
    if (!deps.benchmarkService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "benchmark catalog not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const q = (req.query as Record<string, unknown>).q;
    if (typeof q !== "string" || !q.trim())
      return reply.code(400).send({ code: "BAD_REQUEST", message: "search query q is required." });
    const limitRaw = (req.query as Record<string, unknown>).limit;
    const limit = typeof limitRaw === "string" && Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : undefined;
    try {
      gate(principal, "datasets:read");
      // subject → also used for gated auth via the requester's personal secret (HF_TOKEN) (member self-serve)
      return reply.send(await deps.benchmarkService.searchHf(principal.workspace, q.trim(), limit, principal.subject));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // config/split combinations for the selected HF dataset — for the wizard dropdown (avoids typing a split by hand).
  app.get("/benchmarks/hf/splits", { schema: benchmarkDocs.hfSplits }, async (req, reply) => {
    if (!deps.benchmarkService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "benchmark catalog not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const dataset = (req.query as Record<string, unknown>).dataset;
    if (typeof dataset !== "string" || !dataset.trim())
      return reply.code(400).send({ code: "BAD_REQUEST", message: "dataset is required." });
    try {
      gate(principal, "datasets:read");
      return reply.send(await deps.benchmarkService.hfSplits(principal.workspace, dataset.trim(), principal.subject));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Fallback for datasets not served by the viewer (datasets-server) — a list of repo data files (csv/jsonl/json). For the wizard file dropdown.
  app.get("/benchmarks/hf/files", { schema: benchmarkDocs.hfFiles }, async (req, reply) => {
    if (!deps.benchmarkService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "benchmark catalog not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const dataset = (req.query as Record<string, unknown>).dataset;
    if (typeof dataset !== "string" || !dataset.trim())
      return reply.code(400).send({ code: "BAD_REQUEST", message: "dataset is required." });
    try {
      gate(principal, "datasets:read");
      return reply.send(await deps.benchmarkService.hfFiles(principal.workspace, dataset.trim(), principal.subject));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Source preview — N raw rows before mapping + detected fields (the "Add benchmark" wizard: field auto-detect → mapping). No registration.
  app.post("/benchmarks/preview", { schema: benchmarkDocs.preview }, async (req, reply) => {
    if (!deps.benchmarkService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "benchmark catalog not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "datasets:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = BenchmarkPreviewBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      return reply.send(
        await deps.benchmarkService.previewSource({
          tenant: principal.workspace,
          subject: principal.subject,
          ...parsed.data,
        }),
      );
    } catch (err) {
      return sendError(reply, err); // HF fetch failure / bad jsonl, etc.
    }
  });

  // Pull a catalog/recipe/inline spec and register it as this workspace's dataset (HF sources fetch over the network, using the HF_TOKEN secret if gated).
  app.post("/benchmarks/import", { schema: benchmarkDocs.import }, async (req, reply) => {
    if (!deps.benchmarkService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "benchmark catalog not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "datasets:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = BenchmarkImportBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      const rec = await deps.benchmarkService.import({
        tenant: principal.workspace,
        createdBy: principal.subject,
        ...parsed.data,
      });
      return reply.code(201).send(rec);
    } catch (err) {
      return sendError(reply, err); // BadRequest (unsupported id) / immutable 409 / HF fetch failure
    }
  });

  // Register a tenant benchmark recipe (BenchmarkAdapterSpec, data) — a reusable definition owned by your own workspace.
  app.post("/benchmark-recipes", { schema: benchmarkDocs.registerRecipe }, async (req, reply) => {
    if (!deps.benchmarkService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "benchmark catalog not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "datasets:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = BenchmarkAdapterSpecSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      const rec = await deps.benchmarkService.registerRecipe(principal.workspace, parsed.data);
      return reply.code(201).send(rec);
    } catch (err) {
      return sendError(reply, err); // immutable 409
    }
  });

  // dry-run validate — schema + this workspace's existing versions/conflict (does not register). Pre-check before registering a recipe.
  app.post("/benchmark-recipes/validate", { schema: benchmarkDocs.validateRecipe }, async (req, reply) => {
    if (!deps.benchmarkService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "benchmark catalog not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "datasets:write");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = BenchmarkAdapterSpecSchema.safeParse(req.body);
    if (!parsed.success)
      return reply.send({ ok: false, errors: zodIssues(parsed.error), existingVersions: [], versionExists: false });
    const existingVersions = await deps.benchmarkService.recipeOwnVersions(principal.workspace, parsed.data.id);
    return reply.send({
      ok: true,
      id: parsed.data.id,
      version: parsed.data.version,
      source: parsed.data.source.kind,
      graderTemplates: parsed.data.graderTemplates?.length ?? 0,
      existingVersions,
      versionExists: existingVersions.includes(parsed.data.version),
    });
  });

  // List tenant + _shared recipes.
  app.get("/benchmark-recipes", { schema: benchmarkDocs.listRecipes }, async (req, reply) => {
    if (!deps.benchmarkService)
      return reply.code(404).send({ code: "NOT_FOUND", message: "benchmark catalog not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "datasets:read");
      return reply.send(await deps.benchmarkService.listRecipes(principal.workspace));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string; version: string } }>(
    "/benchmark-recipes/:id/versions/:version",
    { schema: benchmarkDocs.getRecipe },
    async (req, reply) => {
      if (!deps.benchmarkService)
        return reply.code(404).send({ code: "NOT_FOUND", message: "benchmark catalog not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "datasets:read");
        return reply.send(
          await deps.benchmarkService.getRecipe(principal.workspace, req.params.id, req.params.version),
        );
      } catch (err) {
        return sendError(reply, err); // 404 if not found
      }
    },
  );
}
