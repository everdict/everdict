import { ForbiddenError, NotFoundError } from "@everdict/contracts";
import { type Principal, can } from "@everdict/domain";
import type { ModelRegistry } from "../ports/model-registry.js";

// Creator-or-admin gate for deleting one model version, shared by the single- and bulk-delete cores.
// registry.creatorOf throws NotFound (404) for a missing / already-deleted / _shared / other-workspace version, so a
// non-owned target is rejected before any permission decision. Permission: the version's registrant (createdBy ===
// subject) or a workspace admin (models:delete). Otherwise ForbiddenError (403/isError).
async function assertCanDeleteVersion(
  registry: ModelRegistry,
  principal: Principal,
  id: string,
  version: string,
): Promise<void> {
  const ws = principal.workspace;
  const creator = await registry.creatorOf(ws, id, version); // not-owned/deleted/absent → NotFound
  const isAdmin = can(principal, "models:delete"); // admin-only action
  const isCreator = creator !== undefined && creator === principal.subject;
  if (!isAdmin && !isCreator) {
    throw new ForbiddenError(
      "FORBIDDEN",
      { workspace: ws, id, version, action: "models:delete" },
      "You are not allowed to delete this model version (only the version's creator or a workspace admin).",
    );
  }
}

// Shared core for model-version soft delete — the HTTP route (model.routes.ts) and the MCP tool (model.mcp.ts)
// use the same logic (BFF↔MCP parity).
export async function deleteModelVersion(
  registry: ModelRegistry,
  principal: Principal,
  id: string,
  version: string,
): Promise<{ workspace: string; id: string; version: string; deleted: true }> {
  await assertCanDeleteVersion(registry, principal, id, version);
  await registry.softDelete(principal.workspace, id, version);
  return { workspace: principal.workspace, id, version, deleted: true };
}

// Bulk soft delete — several selected versions, or the whole model (all of its own live versions when `versions` is
// omitted). Shared by DELETE /models/:id and the delete_model_versions MCP tool. Fail-fast authorization: every target
// is permission-checked BEFORE any tombstone is written, so a single forbidden/absent version rejects the whole request
// (403/404) with nothing deleted — no surprising partial deletes. An admin can always delete all; an author can
// bulk-delete the versions they registered.
export async function deleteModelVersions(
  registry: ModelRegistry,
  principal: Principal,
  id: string,
  versions?: readonly string[],
): Promise<{ workspace: string; id: string; deleted: string[] }> {
  const ws = principal.workspace;
  // Whole-model delete resolves the target set to this workspace's own live versions (no _shared fallback — shared
  // first-party models aren't deletable). An unknown / already-fully-deleted model yields an empty set → 404 (no existence leak).
  const requested = versions && versions.length > 0 ? versions : await registry.ownVersions(ws, id);
  const targets = [...new Set(requested)];
  if (targets.length === 0) {
    throw new NotFoundError("NOT_FOUND", { workspace: ws, id }, `Model '${id}' not found.`);
  }
  // Authorize (and existence-check) every target first — throws before any softDelete on the first violation.
  for (const version of targets) await assertCanDeleteVersion(registry, principal, id, version);
  for (const version of targets) await registry.softDelete(ws, id, version);
  return { workspace: ws, id, deleted: targets };
}
