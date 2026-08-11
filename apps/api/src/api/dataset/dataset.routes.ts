import { VersionTagsBodySchema, setVersionTags } from "@everdict/application-control";
import { attestDatasetConstitution, deleteDatasetVersion, deleteDatasetVersions } from "@everdict/application-control";
import { TEAM_TRANSFERABLE_CAPABILITIES, moveCapabilityToTeam } from "@everdict/application-control";
import { DatasetSchema } from "@everdict/contracts";
import { diffDatasets, harborToDataset, terminalBenchToDataset } from "@everdict/datasets";
import { ownedByVisibleTeam } from "@everdict/domain";
import type { FastifyInstance } from "fastify";
import { assertEntityVisible, visibleTeamsFor } from "../../common/team-scope.js";
import { capabilityOriginFor, declaredOriginFrom } from "../capability-origin.js";
import { agentAttributionFrom } from "../fs/fs-actor.js";
import {
  type ServerDeps,
  assertDatasetConstitution,
  gate,
  publishDataset,
  resolvePrincipal,
  resolveTeamRef,
  sendError,
  teamForNew,
  zodIssues,
} from "../route-context.js";
import { MoveToTeamBodySchema } from "../team-move.js";
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
    // 새 자산의 소유 팀을 먼저 정하고 그 팀으로 게이트한다 — 등록은 "이 팀 것으로 만든다"이므로, 속하지 않은
    // 팀 앞으로 등록하는 것도 남의 팀 자산을 고치는 것과 같은 거절 사유다. (게이트는 여전히 검증보다 앞선다.)
    let owner: Awaited<ReturnType<typeof teamForNew>>;
    try {
      // 팀 ref 해석(id 또는 key)이 여기서 일어난다 — 없는 팀은 404 이고, 그 답도 게이트와 같은 자리에서 나가야 한다.
      owner = await teamForNew(principal, deps, (req.body as { teamId?: string } | undefined)?.teamId);
      gate(principal, "datasets:write", owner.gate);
    } catch (err) {
      return sendError(reply, err); // no permission 403 (gate before validation — don't leak validation info to the unauthorized)
    }
    const parsed = DatasetSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: "BAD_REQUEST", message: parsed.error.message });
    // Birth stamp beside the spec (the spec schema strips it, so provenance never becomes content).
    const origin = await capabilityOriginFor(
      deps,
      principal.workspace,
      "web",
      agentAttributionFrom(req.headers),
      declaredOriginFrom(req.body),
    );
    try {
      // The constitutional act, gated where the declaration is AUTHORED (arch-review 22 P0-2) — and RECORDED,
      // so the artifact can later say who authorized it (arch-review 23 P1).
      const constitutional = assertDatasetConstitution(principal, parsed.data);
      // Bytes + receipt + capability generation, as ONE publication (creator = subject, for delete rights).
      await publishDataset(deps, principal, parsed.data, constitutional, { teamId: owner.teamId, origin });
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
      const constitutional = assertDatasetConstitution(principal, dataset); // an imported set declares like any other
      await publishDataset(deps, principal, dataset, constitutional);
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
      const constitutional = assertDatasetConstitution(principal, dataset); // an imported set declares like any other
      await publishDataset(deps, principal, dataset, constitutional);
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

  app.get<{ Querystring: { team?: string } }>("/datasets", { schema: datasetDocs.list }, async (req, reply) => {
    if (!deps.datasetRegistry)
      return reply.code(404).send({ code: "NOT_FOUND", message: "dataset registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    try {
      gate(principal, "datasets:read");
      const entries = await deps.datasetRegistry.list(principal.workspace);
      // Two different narrows, in order. The CEILING is ownership: another team's dataset is not the caller's to
      // see, so it never appears (an unowned `_shared` entry is the workspace's and always does). `?team=` is the
      // NARROW on top of it — "of the ones I can see, this team's" — named by id or by key (`?team=ENG`), the
      // same ref the team-scoped URL carries.
      const seen = await visibleTeamsFor(deps, principal);
      const visible = entries.filter((e) => ownedByVisibleTeam(e, seen));
      const team = req.query.team;
      const teamId = team === undefined ? undefined : await resolveTeamRef(deps, principal.workspace, team);
      return reply.send(teamId === undefined ? visible : visible.filter((e) => e.teamId === teamId));
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
        await assertEntityVisible(deps, principal, deps.datasetRegistry, principal.workspace, req.params.id, "dataset");
        return reply.send(await deps.datasetRegistry.get(principal.workspace, req.params.id, req.params.version));
      } catch (err) {
        return sendError(reply, err); // not found → NotFoundError → 404
      }
    },
  );

  // Hand the dataset to another team. A transition, not an edit: it re-files EVERY version at once (ownership
  // belongs to the dataset, not to one release of it) and emits `dataset.moved`, so it gets its own endpoint
  // exactly like the issue's team move does. Both teams are authorized inside the service — the one it is
  // leaving and the one it is joining.
  app.post<{ Params: { id: string } }>("/datasets/:id/team", { schema: datasetDocs.move }, async (req, reply) => {
    if (!deps.datasetRegistry)
      return reply.code(404).send({ code: "NOT_FOUND", message: "dataset registry not configured" });
    const principal = await resolvePrincipal(req, reply, deps);
    if (!principal) return reply;
    const body = MoveToTeamBodySchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ code: "BAD_REQUEST", message: body.error.message });
    try {
      const agent = agentAttributionFrom(req.headers);
      return reply.send(
        await moveCapabilityToTeam({
          registry: deps.datasetRegistry,
          capability: TEAM_TRANSFERABLE_CAPABILITIES.dataset,
          principal,
          id: req.params.id,
          // Resolved here (id or key, `ENG`) so an unknown team is a 404 before the gate compares it against
          // the teams the principal carries — which are ids.
          teamId: await resolveTeamRef(deps, principal.workspace, body.data.teamId),
          ...(deps.platformEvents ? { events: deps.platformEvents } : {}),
          ...(agent ? { agent } : {}),
        }),
      );
    } catch (err) {
      return sendError(reply, err); // not on one of the teams 403 / unknown dataset 404 / already there 409
    }
  });

  // Soft-delete a dataset version — only that version's own creator or a workspace admin (deleteDatasetVersion gates it).
  // Deletion is a tombstone (data preserved, excluded from reads) → past scorecards stay reproducible. Missing/already-deleted/non-owned version = 404.
  // Attest a version whose graders declare ground_truth but that carries no approval — the path that exists
  // because submit REFUSES an unapproved constitutional dataset (arch-review 23 P1). Admin-gated inside the
  // action, beside the rest of the constitutional policy, so both transports inherit one rule.
  app.post<{ Params: { id: string; version: string } }>(
    "/datasets/:id/versions/:version/attest",
    { schema: datasetDocs.attestVersion },
    async (req, reply) => {
      if (!deps.datasetRegistry || !deps.constitutionApprovals)
        return reply.code(404).send({ code: "NOT_FOUND", message: "constitution approvals not configured" });
      const principal = await resolvePrincipal(req, reply, deps);
      if (!principal) return reply;
      try {
        return reply.send(
          await attestDatasetConstitution(
            { datasets: deps.datasetRegistry, approvals: deps.constitutionApprovals },
            principal,
            req.params.id,
            req.params.version,
          ),
        );
      } catch (err) {
        return sendError(reply, err); // not admin 403 / unknown version 404 / nothing to attest 400
      }
    },
  );

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
        await assertEntityVisible(deps, principal, deps.datasetRegistry, principal.workspace, req.params.id, "dataset");
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
