import type { Principal } from "@everdict/domain";
import type { JudgeRegistry } from "../ports/judge-registry.js";
import { deleteVersionedResource } from "../versioned-resource/versioned-resource-delete.js";

// Shared core for Agent Judge version soft delete — the HTTP route (judge.routes.ts) and the MCP tool (judge.mcp.ts) use
// the same logic (BFF↔MCP parity). Same pattern as harness delete (harness-service.deleteHarnessVersion).
// registry.creatorOfVersion throws NotFound (404) for a missing / already-deleted / _shared / other-workspace version, so a
// non-owned target is rejected before any permission decision. Permission: the version's registrant (createdBy === subject)
// or a workspace admin (judges:delete). Otherwise ForbiddenError (403/isError).
// Delete is a tombstone — data preserved (past scorecards hold the judge coordinates as a snapshot, so history/aggregation
// are unaffected), excluded only from reads. Future scorecards referencing that judge fail to resolve.
export function deleteJudgeVersion(
  registry: JudgeRegistry,
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
    { permission: "judges:delete", noun: "judge" },
    principal,
    id,
    version,
  );
}
