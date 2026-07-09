import {
  AppError,
  HarnessInstanceSpecSchema,
  type ImageWarning,
  collectHarnessImages,
  imageWarnings,
  resolveHarnessInstance,
} from "@everdict/core";
import type { FastifyInstance } from "fastify";
import { VersionTagsBodySchema, setVersionTags } from "../../common/version-tag-service.js";
import { RepinBodySchema, repinHarnessImages } from "../../core/harness/harness-pin-service.js";
import { deleteHarnessVersion, harnessIsPrivate, harnessVisibleTo } from "../../core/harness/harness-service.js";
import { type ServerDeps, gate, resolvePrincipal, sendError, zodIssues } from "../route-context.js";
import { harnessDocs } from "./harness.docs.js";

// Individual harnesses (instances) — /harnesses is the instance surface (category = /harness-templates). template reference + pins.
// Ungated (viewer+). Register/validate confirm via resolve (missing template → 404 / missing pin → 400 rejection).
export function registerHarnessRoutes(app: FastifyInstance, deps: ServerDeps): void {
  // Individual harnesses (instances) — /harnesses is the instance surface (category = /harness-templates). template reference + pins.
  // Ungated (viewer+). Register/validate confirm via resolve (missing template → 404 / missing pin → 400 rejection).
  app.post("/harnesses", { schema: harnessDocs.register }, async (req, reply) => {
    if (!deps.harnessInstances)
      return reply.code(404).send({ code: "NOT_FOUND", message: "harness instance registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const parsed = HarnessInstanceSpecSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      gate(principal, "harnesses:register");
      await deps.harnessInstances.register(principal.workspace, parsed.data, principal.subject);
      // Image-classification warnings (warn-not-block) — local/unqualified images have no pull guarantee (risky to run off the build machine).
      const warnings = await harnessImageWarnings(deps, principal.workspace, parsed.data.id, parsed.data.version);
      // Visibility tradeoff surfaced at write time: a user-scope secretRef makes the harness visible to you only.
      const isPrivate = await harnessIsPrivate(
        deps.harnessInstances,
        principal.workspace,
        parsed.data.id,
        parsed.data.version,
      );
      return reply.code(201).send({
        workspace: principal.workspace,
        id: parsed.data.id,
        version: parsed.data.version,
        ...(warnings.length > 0 ? { imageWarnings: warnings } : {}),
        ...(isPrivate ? { private: true } : {}),
      });
    } catch (err) {
      return sendError(reply, err); // missing template 404 / missing pin 400 / immutable 409
    }
  });

  // dry-run validate — schema + template existence + pins resolve (does not register). Pre-check for the register flow.
  app.post("/harnesses/validate", { schema: harnessDocs.validate }, async (req, reply) => {
    if (!deps.harnessTemplates)
      return reply.code(404).send({ code: "NOT_FOUND", message: "harness template registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "harnesses:register");
    } catch (err) {
      return sendError(reply, err);
    }
    const parsed = HarnessInstanceSpecSchema.safeParse(req.body);
    if (!parsed.success) return reply.send({ ok: false, errors: zodIssues(parsed.error) });
    try {
      const template = await deps.harnessTemplates.get(
        principal.workspace,
        parsed.data.template.id,
        parsed.data.template.version,
      );
      const resolved = resolveHarnessInstance(template, parsed.data); // throws on missing/mismatched pin or missing template
      // Image-classification warnings (warn-not-block) — the pre-registration check surfaces local/unqualified images.
      // Classification runs against *all* registered registries — belonging to any one makes it the workspace class.
      const coords = await deps.imageRegistryService?.coordinates(principal.workspace);
      const warnings = imageWarnings(collectHarnessImages(resolved), coords);
      return reply.send({
        ok: true,
        kind: resolved.kind,
        id: parsed.data.id,
        version: parsed.data.version,
        ...(warnings.length > 0 ? { imageWarnings: warnings } : {}),
      });
    } catch (err) {
      return reply.send({ ok: false, errors: [err instanceof AppError ? err.message : String(err)] });
    }
  });

  app.get("/harnesses", { schema: harnessDocs.list }, async (req, reply) => {
    if (!deps.harnessInstances)
      return reply.code(404).send({ code: "NOT_FOUND", message: "harness instance registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "harnesses:read");
      const entries = await deps.harnessInstances.list(principal.workspace); // instances grouped by template id
      // A private harness (references a personal secret) is owner-only — the owner is the creator of the latest
      // version (the one that decides privacy), falling back to the id-level creator for older data.
      return reply.send(entries.filter((e) => !e.private || (e.latestCreatedBy ?? e.createdBy) === principal.subject));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/harnesses/:id", { schema: harnessDocs.versions }, async (req, reply) => {
    if (!deps.harnessInstances)
      return reply.code(404).send({ code: "NOT_FOUND", message: "harness instance registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "harnesses:read");
      const versions = await deps.harnessInstances.versions(principal.workspace, req.params.id);
      if (versions.length === 0) return reply.code(404).send({ code: "NOT_FOUND", message: "harness not found." });
      if (!(await harnessVisibleTo(deps.harnessInstances, principal, req.params.id)))
        return reply.code(404).send({ code: "NOT_FOUND", message: "harness not found." });
      // versionTags: version → free label (only versions that have tags) — a display aid to tell versions apart in the switcher/list.
      const versionTags = await deps.harnessInstances.versionTags(principal.workspace, req.params.id);
      return reply.send({
        id: req.params.id,
        versions,
        ...(Object.keys(versionTags).length > 0 ? { versionTags } : {}),
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string; version: string } }>(
    "/harnesses/:id/:version",
    { schema: harnessDocs.resolved },
    async (req, reply) => {
      if (!deps.harnessInstances)
        return reply.code(404).send({ code: "NOT_FOUND", message: "harness instance registry not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "harnesses:read");
        // resolved HarnessSpec (template + pins) — for the web pin diff/preview.
        const resolved = await deps.harnessInstances.get(principal.workspace, req.params.id, req.params.version);
        // A private harness (references a personal secret) is viewable only by its owner → others get 404 (existence
        // hidden). Owner semantics live in the one shared helper (latest-version creator) — no inline fork.
        if (!(await harnessVisibleTo(deps.harnessInstances, principal, req.params.id)))
          return reply.code(404).send({ code: "NOT_FOUND", message: "harness not found." });
        return reply.send(resolved);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Raw instance (template reference + pins) — the original before resolve. For the detail-view config panel + new-version re-pin prefill.
  app.get<{ Params: { id: string; version: string } }>(
    "/harnesses/:id/:version/instance",
    { schema: harnessDocs.instance },
    async (req, reply) => {
      if (!deps.harnessInstances)
        return reply.code(404).send({ code: "NOT_FOUND", message: "harness instance registry not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        gate(principal, "harnesses:read");
        // Same owner-only 404 as the resolved read — a private harness's raw instance (existence, pins) is not
        // visible to other members either.
        if (!(await harnessVisibleTo(deps.harnessInstances, principal, req.params.id)))
          return reply.code(404).send({ code: "NOT_FOUND", message: "harness not found." });
        return reply.send(
          await deps.harnessInstances.getInstance(principal.workspace, req.params.id, req.params.version),
        );
      } catch (err) {
        return sendError(reply, err); // missing id/version → 404
      }
    },
  );

  // Soft-delete a harness version — only that version's own creator or a workspace admin (deleteHarnessVersion gates it).
  // Deletion is a tombstone (data preserved, excluded from reads) → past scorecard history·aggregates are unaffected (the harness coordinates are snapshotted in the record).
  // "Future" runs referencing that harness (re-run/schedule/CI) fail to resolve. Missing/already-deleted/non-owned version = 404.
  app.delete<{ Params: { id: string; version: string } }>(
    "/harnesses/:id/versions/:version",
    { schema: harnessDocs.deleteVersion },
    async (req, reply) => {
      if (!deps.harnessInstances)
        return reply.code(404).send({ code: "NOT_FOUND", message: "harness instance registry not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        return reply.send(
          await deleteHarnessVersion(deps.harnessInstances, principal, req.params.id, req.params.version),
        );
      } catch (err) {
        return sendError(reply, err); // no permission 403 / not found 404
      }
    },
  );

  // Replace version tags (whole-array PUT; empty array = clear) — mutable metadata outside the spec (free labels, to tell versions apart).
  // Same gate as register (harnesses:register, viewer+) — curating collaborative eval content. _shared / other-workspace versions = 404.
  app.put<{ Params: { id: string; version: string } }>(
    "/harnesses/:id/versions/:version/tags",
    { schema: harnessDocs.setVersionTags },
    async (req, reply) => {
      if (!deps.harnessInstances)
        return reply.code(404).send({ code: "NOT_FOUND", message: "harness instance registry not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      const parsed = VersionTagsBodySchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
      try {
        // A private harness (references a personal secret) is createdBy-only — existence hidden from others (404, same as read).
        if (!(await harnessVisibleTo(deps.harnessInstances, principal, req.params.id)))
          return reply.code(404).send({ code: "NOT_FOUND", message: "harness not found." });
        return reply.send(
          await setVersionTags(
            deps.harnessInstances,
            principal,
            "harnesses:register",
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

  // Durable re-pin (headless re-pin) — merge into the base instance's pins and register a new version (same meaning as the web "Create new version").
  // The path where CI (dev/main merge) swaps only its own service slot. Enforces digest pins (default), idempotent (identical pins → unchanged).
  app.post<{ Params: { id: string } }>("/harnesses/:id/pins", { schema: harnessDocs.repin }, async (req, reply) => {
    if (!deps.harnessInstances)
      return reply.code(404).send({ code: "NOT_FOUND", message: "harness instance registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const parsed = RepinBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    try {
      gate(principal, "harnesses:register"); // same gate as instance register (ungated viewer+; the CI role has it too)
      const result = await repinHarnessImages(
        deps.harnessInstances,
        principal.workspace,
        principal.subject,
        req.params.id,
        parsed.data,
      );
      return reply.code(result.unchanged ? 200 : 201).send(result);
    } catch (err) {
      return sendError(reply, err); // missing base 404 / tag pin·unknown slot 400 / version immutable 409
    }
  });
}

// Image-classification warnings right after registration — classify the resolved spec's images against the workspace registries
// and keep only local/unqualified (no pull guarantee). A failure to compute warnings does not block registration (warn-not-block).
async function harnessImageWarnings(
  deps: ServerDeps,
  workspace: string,
  id: string,
  version: string,
): Promise<ImageWarning[]> {
  if (!deps.harnessInstances) return [];
  try {
    const resolved = await deps.harnessInstances.get(workspace, id, version);
    // Classification runs against *all* registered registries — belonging to any one makes it the workspace class.
    const coords = await deps.imageRegistryService?.coordinates(workspace);
    return imageWarnings(collectHarnessImages(resolved), coords);
  } catch {
    return [];
  }
}
