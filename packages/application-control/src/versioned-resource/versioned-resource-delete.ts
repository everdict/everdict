import { ForbiddenError, NotFoundError } from "@everdict/contracts";
import { type Action, type Principal, can } from "@everdict/domain";

// ONE deletion policy for every versioned registry resource (review §23): dataset / model / agent carried
// byte-for-byte copies of the creator-or-admin gate, the fail-fast bulk preauthorization and the soft
// delete, and harness / judge carried a third near-copy — five places for one rule, drifting one edit at a
// time. The PUBLIC vocabulary stays concrete (deleteDatasetVersion, delete_model_versions, …: thin named
// wrappers in each resource's service); the MECHANICS live here once.
//
// The registry adapter is structural: `creatorOf` throws NotFound (404) for a missing / already-deleted /
// _shared / other-workspace version, so a non-owned target is rejected before any permission decision.
export interface VersionedDeleteRegistry {
  creatorOf(workspace: string, id: string, version: string): Promise<string | undefined>;
  softDelete(workspace: string, id: string, version: string): Promise<void>;
  // Whole-resource bulk delete resolves to this workspace's own live versions (no _shared fallback — shared
  // resources are not deletable). Absent = the resource supports single-version delete only.
  ownVersions?(workspace: string, id: string): Promise<string[]>;
}

export interface VersionedResourceKind {
  permission: Action; // e.g. "datasets:delete" — the admin half of creator-or-admin
  noun: string; // "dataset" — the word the refusal names
}

// Creator-or-admin gate for one version. Permission: the version's registrant (createdBy === subject) or a
// workspace admin (the kind's delete action). Otherwise ForbiddenError (403).
async function assertCanDeleteVersion(
  registry: VersionedDeleteRegistry,
  kind: VersionedResourceKind,
  principal: Principal,
  id: string,
  version: string,
): Promise<void> {
  const ws = principal.workspace;
  const creator = await registry.creatorOf(ws, id, version); // not-owned/deleted/absent → NotFound
  const isAdmin = can(principal, kind.permission);
  const isCreator = creator !== undefined && creator === principal.subject;
  if (!isAdmin && !isCreator) {
    throw new ForbiddenError(
      "FORBIDDEN",
      { workspace: ws, id, version, action: kind.permission },
      `You are not allowed to delete this ${kind.noun} version (only the version's creator or a workspace admin).`,
    );
  }
}

export async function deleteVersionedResource(
  registry: VersionedDeleteRegistry,
  kind: VersionedResourceKind,
  principal: Principal,
  id: string,
  version: string,
): Promise<{ workspace: string; id: string; version: string; deleted: true }> {
  await assertCanDeleteVersion(registry, kind, principal, id, version);
  await registry.softDelete(principal.workspace, id, version);
  return { workspace: principal.workspace, id, version, deleted: true };
}

// Bulk soft delete — several selected versions, or the whole resource (all of its own live versions when
// `versions` is omitted). Fail-fast authorization: every target is permission-checked BEFORE any tombstone
// is written, so a single forbidden/absent version rejects the whole request (403/404) with nothing deleted —
// no surprising partial deletes. An admin can always delete all; an author can bulk-delete the versions they
// registered. An unknown / already-fully-deleted resource yields an empty set → 404 (no existence leak).
export async function deleteVersionedResources(
  registry: Required<VersionedDeleteRegistry>,
  kind: VersionedResourceKind,
  principal: Principal,
  id: string,
  versions?: readonly string[],
): Promise<{ workspace: string; id: string; deleted: string[] }> {
  const ws = principal.workspace;
  const requested = versions && versions.length > 0 ? versions : await registry.ownVersions(ws, id);
  const targets = [...new Set(requested)];
  if (targets.length === 0) {
    const capitalized = kind.noun.charAt(0).toUpperCase() + kind.noun.slice(1);
    throw new NotFoundError("NOT_FOUND", { workspace: ws, id }, `${capitalized} '${id}' not found.`);
  }
  for (const version of targets) await assertCanDeleteVersion(registry, kind, principal, id, version);
  for (const version of targets) await registry.softDelete(ws, id, version);
  return { workspace: ws, id, deleted: targets };
}
