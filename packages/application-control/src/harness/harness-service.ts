import { type Principal, referencesUserSecret } from "@everdict/domain";
import type { HarnessInstanceRegistry } from "../ports/harness-instance-registry.js";
import { deleteVersionedResource } from "../versioned-resource/versioned-resource-delete.js";

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
export function deleteHarnessVersion(
  registry: HarnessInstanceRegistry,
  principal: Principal,
  id: string,
  version: string,
): Promise<{ workspace: string; id: string; version: string; deleted: true }> {
  // Same policy as every versioned resource (versioned-resource-delete.ts) — this registry spells the
  // creator lookup `creatorOfVersion`, adapted structurally; no bulk here (no ownVersions on the port).
  return deleteVersionedResource(
    {
      creatorOf: (ws, rid, v) => registry.creatorOfVersion(ws, rid, v),
      softDelete: (ws, rid, v) => registry.softDelete(ws, rid, v),
    },
    { permission: "harnesses:delete", noun: "harness" },
    principal,
    id,
    version,
  );
}
