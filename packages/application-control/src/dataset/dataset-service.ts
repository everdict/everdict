import { ForbiddenError, NotFoundError } from "@everdict/contracts";
import { type Principal, can } from "@everdict/domain";
import type { DatasetRegistry } from "../ports/dataset-registry.js";

// Creator-or-admin gate for deleting one dataset version, shared by the single- and bulk-delete cores.
// registry.creatorOf throws NotFound (404) for a missing / already-deleted / _shared / other-workspace version, so a
// non-owned target is rejected before any permission decision. Permission: the version's registrant (createdBy ===
// subject) or a workspace admin (datasets:delete). Otherwise ForbiddenError (403/isError).
async function assertCanDeleteVersion(
  registry: DatasetRegistry,
  principal: Principal,
  id: string,
  version: string,
): Promise<void> {
  const ws = principal.workspace;
  const creator = await registry.creatorOf(ws, id, version); // not-owned/deleted/absent → NotFound
  const isAdmin = can(principal, "datasets:delete"); // admin-only action
  const isCreator = creator !== undefined && creator === principal.subject;
  if (!isAdmin && !isCreator) {
    throw new ForbiddenError(
      "FORBIDDEN",
      { workspace: ws, id, version, action: "datasets:delete" },
      "You are not allowed to delete this dataset version (only the version's creator or a workspace admin).",
    );
  }
}

// Shared core for dataset-version soft delete — the HTTP route (dataset.routes.ts) and the MCP tool (dataset.mcp.ts)
// use the same logic (BFF↔MCP parity).
export async function deleteDatasetVersion(
  registry: DatasetRegistry,
  principal: Principal,
  id: string,
  version: string,
): Promise<{ workspace: string; id: string; version: string; deleted: true }> {
  await assertCanDeleteVersion(registry, principal, id, version);
  await registry.softDelete(principal.workspace, id, version);
  return { workspace: principal.workspace, id, version, deleted: true };
}

// Bulk soft delete — several selected versions, or the whole dataset (all of its own live versions when `versions` is
// omitted). Shared by DELETE /datasets/:id and the delete_dataset_versions MCP tool. Fail-fast authorization: every
// target is permission-checked BEFORE any tombstone is written, so a single forbidden/absent version rejects the whole
// request (403/404) with nothing deleted — no surprising partial deletes. An admin can always delete all; an author can
// bulk-delete the versions they registered.
export async function deleteDatasetVersions(
  registry: DatasetRegistry,
  principal: Principal,
  id: string,
  versions?: readonly string[],
): Promise<{ workspace: string; id: string; deleted: string[] }> {
  const ws = principal.workspace;
  // Whole-dataset delete resolves the target set to this workspace's own live versions (no _shared fallback — shared
  // benchmarks aren't deletable). An unknown / already-fully-deleted dataset yields an empty set → 404 (no existence leak).
  const requested = versions && versions.length > 0 ? versions : await registry.ownVersions(ws, id);
  const targets = [...new Set(requested)];
  if (targets.length === 0) {
    throw new NotFoundError("NOT_FOUND", { workspace: ws, id }, `Dataset '${id}' not found.`);
  }
  // Authorize (and existence-check) every target first — throws before any softDelete on the first violation.
  for (const version of targets) await assertCanDeleteVersion(registry, principal, id, version);
  for (const version of targets) await registry.softDelete(ws, id, version);
  return { workspace: ws, id, deleted: targets };
}
