import { VersionTagsBodySchema, setVersionTags } from "@everdict/application-control";
import { TEAM_TRANSFERABLE_CAPABILITIES, moveCapabilityToTeam } from "@everdict/application-control";
import { RepinBodySchema, repinHarnessImages } from "@everdict/application-control";
import { deleteHarnessVersion, harnessIsPrivate, harnessVisibleTo } from "@everdict/application-control";
import { AppError, HarnessInstanceSpecSchema, type ImageWarning, resolveHarnessInstance } from "@everdict/contracts";
import {
  checkPortability,
  classifyImageRef,
  collectHarnessImages,
  diffHarnessSpecs,
  imageWarnings,
} from "@everdict/domain";
import { ownedByVisibleTeam } from "@everdict/domain";
import type { FastifyInstance } from "fastify";
import { assertEntityVisible, teamOfEntity, visibleTeamsFor } from "../../common/team-scope.js";
import { capabilityOriginFor, declaredOriginFrom } from "../capability-origin.js";
import { agentAttributionFrom } from "../fs/fs-actor.js";
import {
  type ServerDeps,
  gate,
  resolvePrincipal,
  resolveTeamRef,
  sendError,
  teamForNew,
  zodIssues,
} from "../route-context.js";
import { MoveToTeamBodySchema } from "../team-move.js";
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
      // 새 자산의 소유 팀을 먼저 정하고 그 팀으로 게이트한다 — 등록은 곧 "이 팀 것으로 만든다"이므로,
      // 내가 속하지 않은 팀 앞으로 등록하는 것도 남의 팀 자산을 고치는 것과 같은 거절 사유다.
      const owner = await teamForNew(principal, deps, (req.body as { teamId?: string } | undefined)?.teamId);
      gate(principal, "harnesses:register", owner.gate);
      // Structural portability errors are hard-blocked inside the registry's register (the single chokepoint every path
      // — route/bundle/MCP — flows through). Host-literal warnings do NOT block; surface them so the author can migrate.
      // docs/architecture/topology-portability.md.
      let portabilityWarnings: string[] = [];
      if (deps.harnessTemplates) {
        const template = await deps.harnessTemplates.get(
          principal.workspace,
          parsed.data.template.id,
          parsed.data.template.version,
        );
        const resolved = resolveHarnessInstance(template, parsed.data);
        if (resolved.kind === "service")
          portabilityWarnings = checkPortability(resolved)
            .filter((i) => i.severity === "warning")
            .map((i) => i.message);
      }
      // Birth stamp beside the spec (the spec schema strips it, so provenance never becomes content).
      const origin = await capabilityOriginFor(
        deps,
        principal.workspace,
        "web",
        agentAttributionFrom(req.headers),
        declaredOriginFrom(req.body),
        { type: "harness", id: parsed.data.id },
      );
      await deps.harnessInstances.register(principal.workspace, parsed.data, principal.subject, owner.teamId, origin);
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
        ...(portabilityWarnings.length > 0 ? { portabilityWarnings } : {}),
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
      // Portability lint — structural errors fail the dry-run (ok:false) like a schema/pin failure (register hard-blocks
      // the same); host-literal warnings are surfaced (non-blocking) so the author can migrate. docs/architecture/topology-portability.md.
      let portabilityWarnings: string[] = [];
      if (resolved.kind === "service") {
        const portabilityIssues = checkPortability(resolved);
        const errors = portabilityIssues.filter((i) => i.severity === "error");
        if (errors.length > 0) return reply.send({ ok: false, errors: errors.map((i) => i.message) });
        portabilityWarnings = portabilityIssues.filter((i) => i.severity === "warning").map((i) => i.message);
      }
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
        ...(portabilityWarnings.length > 0 ? { portabilityWarnings } : {}),
      });
    } catch (err) {
      return reply.send({ ok: false, errors: [err instanceof AppError ? err.message : String(err)] });
    }
  });

  app.get<{ Querystring: { team?: string } }>("/harnesses", { schema: harnessDocs.list }, async (req, reply) => {
    if (!deps.harnessInstances)
      return reply.code(404).send({ code: "NOT_FOUND", message: "harness instance registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "harnesses:read");
      const entries = await deps.harnessInstances.list(principal.workspace); // instances grouped by template id
      // A private harness (references a personal secret) is owner-only — the owner is the creator of the latest
      // version (the one that decides privacy), falling back to the id-level creator for older data.
      // Two separate ceilings, both "not yours to see": a personal secret makes a harness its owner's, and a
      // PRIVATE team makes its work its members'. Neither is about the roster of an ordinary team.
      const seen = await visibleTeamsFor(deps, principal);
      const visible = entries
        .filter((e) => !e.private || (e.latestCreatedBy ?? e.createdBy) === principal.subject)
        .filter((e) => ownedByVisibleTeam(e, seen));
      // `?team=` is the NARROW on top of them — "of the ones I can see, this team's". Named by id or by key
      // (`?team=ENG`), the same ref the team-scoped URL carries.
      const team = req.query.team;
      const teamId = team === undefined ? undefined : await resolveTeamRef(deps, principal.workspace, team);
      return reply.send(teamId === undefined ? visible : visible.filter((e) => e.teamId === teamId));
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
      await assertEntityVisible(deps, principal, deps.harnessInstances, principal.workspace, req.params.id, "harness");
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

  // Structural config diff between two versions — resolved spec (template + pins applied), leaf field changes by path.
  // Both refs may be "latest". Immutable-version premise → reproducible. Static "diff" segment resolves ahead of :version.
  app.get<{ Params: { id: string }; Querystring: { base?: string; candidate?: string } }>(
    "/harnesses/:id/diff",
    { schema: harnessDocs.diff },
    async (req, reply) => {
      if (!deps.harnessInstances)
        return reply.code(404).send({ code: "NOT_FOUND", message: "harness instance registry not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      const { base, candidate } = req.query;
      if (!base || !candidate)
        return reply
          .code(400)
          .send({ code: "BAD_REQUEST", message: "base and candidate query parameters are required." });
      try {
        gate(principal, "harnesses:read");
        // A private harness (references a personal secret) is owner-only — existence hidden from others (404, same as the reads).
        if (!(await harnessVisibleTo(deps.harnessInstances, principal, req.params.id)))
          return reply.code(404).send({ code: "NOT_FOUND", message: "harness not found." });
        await assertEntityVisible(
          deps,
          principal,
          deps.harnessInstances,
          principal.workspace,
          req.params.id,
          "harness",
        );
        const [baseSpec, candidateSpec] = await Promise.all([
          deps.harnessInstances.get(principal.workspace, req.params.id, base),
          deps.harnessInstances.get(principal.workspace, req.params.id, candidate),
        ]);
        return reply.send(diffHarnessSpecs(baseSpec, candidateSpec));
      } catch (err) {
        return sendError(reply, err); // version not found → 404
      }
    },
  );

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
        await assertEntityVisible(
          deps,
          principal,
          deps.harnessInstances,
          principal.workspace,
          req.params.id,
          "harness",
        );
        // Served image classification (re-architecture P1g) — per-image workspace/external/local/unqualified,
        // computed against ALL workspace registries at serve time so the web badge doesn't re-implement the rule.
        const coords = await deps.imageRegistryService?.coordinates(principal.workspace);
        const imageClasses = collectHarnessImages(resolved).map((image) => ({
          image,
          class: classifyImageRef(image, coords),
        }));
        return reply.send({ ...resolved, ...(imageClasses.length > 0 ? { imageClasses } : {}) });
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
        await assertEntityVisible(
          deps,
          principal,
          deps.harnessInstances,
          principal.workspace,
          req.params.id,
          "harness",
        );
        return reply.send(
          await deps.harnessInstances.getInstance(principal.workspace, req.params.id, req.params.version),
        );
      } catch (err) {
        return sendError(reply, err); // missing id/version → 404
      }
    },
  );

  // Hand the harness to another team. A transition, not an edit: it re-files EVERY version at once (ownership
  // belongs to the harness, not to one release of it) and emits `harness.moved`, so it gets its own endpoint
  // exactly like the issue's team move does. Both teams are authorized inside the service — the one it is
  // leaving and the one it is joining.
  app.post<{ Params: { id: string } }>("/harnesses/:id/team", { schema: harnessDocs.move }, async (req, reply) => {
    if (!deps.harnessInstances)
      return reply.code(404).send({ code: "NOT_FOUND", message: "harness instance registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = MoveToTeamBodySchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    try {
      const agent = agentAttributionFrom(req.headers);
      return reply.send(
        await moveCapabilityToTeam({
          registry: deps.harnessInstances,
          capability: TEAM_TRANSFERABLE_CAPABILITIES.harness,
          principal,
          id: req.params.id,
          // Resolved here (id or key, `ENG`) so an unknown team is a 404 before the gate compares it against the
          // teams the principal carries — which are ids.
          teamId: await resolveTeamRef(deps, principal.workspace, body.data.teamId),
          ...(deps.platformEvents ? { events: deps.platformEvents } : {}),
          ...(agent ? { agent } : {}),
        }),
      );
    } catch (err) {
      return sendError(reply, err); // not on one of the teams 403 / unknown harness 404 / already there 409
    }
  });

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
      // 기존 엔티티의 소유 팀으로 게이트 — 재핀은 남의 팀 하네스를 바꾸는 쓰기다.
      // Read ONCE and carried: the service lets the store re-read the owner where it writes, so a transfer
      // landing between the gate and the write files the successor under a team this caller was never
      // cleared for (arch-review 117 — the sibling of 115's adoption lane).
      const owner = await teamOfEntity(deps.harnessInstances, principal.workspace, req.params.id);
      gate(principal, "harnesses:register", owner); // same gate as instance register (ungated viewer+; CI too)
      // The channel is the route's contribution to the origin; the merge base is the service's — only it
      // knows the base at the write (docs/architecture/evolution-lineage.md, Track A). The keyless GitHub
      // Actions federation authenticates as the `ci` role, which is what tells a headless re-pin apart here.
      const agent = agentAttributionFrom(req.headers);
      const result = await repinHarnessImages(
        deps.harnessInstances,
        principal.workspace,
        principal.subject,
        req.params.id,
        parsed.data,
        {
          via: principal.roles.includes("ci") ? "ci" : "web",
          ...(agent?.agentId !== undefined ? { agentId: agent.agentId } : {}),
          ...(agent?.agentName !== undefined ? { agentName: agent.agentName } : {}),
          ...(agent?.conversationId !== undefined ? { conversationId: agent.conversationId } : {}),
          ...(agent?.runId !== undefined ? { runId: agent.runId } : {}),
        },
        { expectedOwnerTeamId: owner.teamId },
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
