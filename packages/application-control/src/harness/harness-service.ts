import { ForbiddenError } from "@everdict/contracts";
import { type Principal, can, referencesUserSecret } from "@everdict/domain";
import type { HarnessInstanceRegistry } from "../ports/harness-instance-registry.js";

// A private (personal-secret-referencing) harness is visible only to its owner — decided by resolving the latest version.
// The owner is the creator of that SAME latest version (the version whose spec makes it private) — not the id-level
// (earliest-version) creator: an id whose first version was registered without a creator stamp (or by someone else)
// must not hide a later private version from the person who registered it.
// A resolve failure is treated as "can't determine visibility" and not blocked (the caller's other 404 path handles it).
// Shared by the HTTP routes (server.ts) and MCP tools (mcp.ts) (BFF↔MCP parity).
export async function harnessVisibleTo(
  registry: HarnessInstanceRegistry,
  principal: Principal,
  id: string,
): Promise<boolean> {
  try {
    const resolved = await registry.get(principal.workspace, id);
    if (!referencesUserSecret(resolved)) return true;
    const latest = (await registry.versions(principal.workspace, id)).at(-1);
    if (latest === undefined) return true;
    return (await registry.creatorOfVersion(principal.workspace, id, latest)) === principal.subject;
  } catch {
    return true;
  }
}

// Whether a just-registered version resolves to a user-secret (private) harness — surfaced in the register response
// (HTTP + MCP) so the registrant learns the visibility tradeoff at write time, not when teammates report a 404.
// Resolve failure → false (the register call itself already validated the spec; this is display metadata only).
export async function harnessIsPrivate(
  registry: HarnessInstanceRegistry,
  workspace: string,
  id: string,
  version: string,
): Promise<boolean> {
  try {
    return referencesUserSecret(await registry.get(workspace, id, version));
  } catch {
    return false;
  }
}

// Shared core for harness (instance) version soft delete — the HTTP routes (server.ts) and MCP tools (mcp.ts) use the same
// logic (BFF↔MCP parity). Same pattern as dataset delete (dataset-service.deleteDatasetVersion).
// Permission: only the version's registrant (createdBy === subject) or a workspace admin (harnesses:delete).
// Delete is a tombstone — data preserved (past scorecards hold the harness coordinates as a snapshot, so history/aggregation are unaffected),
// excluded only from reads. "Future" runs referencing that harness (re-run/schedule/CI) fail to resolve.
// Missing · already-deleted · _shared · other-workspace versions are NotFound (404) from the registry.
export async function deleteHarnessVersion(
  registry: HarnessInstanceRegistry,
  principal: Principal,
  id: string,
  version: string,
): Promise<{ workspace: string; id: string; version: string; deleted: true }> {
  const ws = principal.workspace;
  const creator = await registry.creatorOfVersion(ws, id, version); // not-owned/deleted/absent → NotFound
  const isAdmin = can(principal, "harnesses:delete"); // admin-only action
  const isCreator = creator !== undefined && creator === principal.subject;
  if (!isAdmin && !isCreator) {
    throw new ForbiddenError(
      "FORBIDDEN",
      { workspace: ws, id, version, action: "harnesses:delete" },
      "You are not allowed to delete this harness version (only the version's creator or a workspace admin).",
    );
  }
  await registry.softDelete(ws, id, version);
  return { workspace: ws, id, version, deleted: true };
}
