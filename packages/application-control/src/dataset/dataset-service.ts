import { ForbiddenError } from "@everdict/contracts";
import { type Principal, can } from "@everdict/domain";
import type { DatasetRegistry } from "../ports/dataset-registry.js";

// Shared core for dataset-version soft delete — the HTTP route (server.ts) and the MCP tool (mcp.ts) use the same logic (BFF↔MCP parity).
// Permission: only the version's registrant (createdBy === subject) or a workspace admin (datasets:delete).
// Otherwise ForbiddenError (403/isError). Missing · already-deleted · _shared · other-workspace versions are NotFound (404) from the registry.
export async function deleteDatasetVersion(
  registry: DatasetRegistry,
  principal: Principal,
  id: string,
  version: string,
): Promise<{ workspace: string; id: string; version: string; deleted: true }> {
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
  await registry.softDelete(ws, id, version);
  return { workspace: ws, id, version, deleted: true };
}
