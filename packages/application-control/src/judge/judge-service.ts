import { ForbiddenError } from "@everdict/contracts";
import { type Principal, can } from "@everdict/domain";
import type { JudgeRegistry } from "../ports/judge-registry.js";

// Shared core for Agent Judge version soft delete — the HTTP route (judge.routes.ts) and the MCP tool (judge.mcp.ts) use
// the same logic (BFF↔MCP parity). Same pattern as harness delete (harness-service.deleteHarnessVersion).
// registry.creatorOfVersion throws NotFound (404) for a missing / already-deleted / _shared / other-workspace version, so a
// non-owned target is rejected before any permission decision. Permission: the version's registrant (createdBy === subject)
// or a workspace admin (judges:delete). Otherwise ForbiddenError (403/isError).
// Delete is a tombstone — data preserved (past scorecards hold the judge coordinates as a snapshot, so history/aggregation
// are unaffected), excluded only from reads. Future scorecards referencing that judge fail to resolve.
export async function deleteJudgeVersion(
  registry: JudgeRegistry,
  principal: Principal,
  id: string,
  version: string,
): Promise<{ workspace: string; id: string; version: string; deleted: true }> {
  const ws = principal.workspace;
  const creator = await registry.creatorOfVersion(ws, id, version); // not-owned/deleted/absent → NotFound
  const isAdmin = can(principal, "judges:delete"); // admin-only action
  const isCreator = creator !== undefined && creator === principal.subject;
  if (!isAdmin && !isCreator) {
    throw new ForbiddenError(
      "FORBIDDEN",
      { workspace: ws, id, version, action: "judges:delete" },
      "You are not allowed to delete this judge version (only the version's creator or a workspace admin).",
    );
  }
  await registry.softDelete(ws, id, version);
  return { workspace: ws, id, version, deleted: true };
}
