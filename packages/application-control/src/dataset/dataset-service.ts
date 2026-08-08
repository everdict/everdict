import type { Principal } from "@everdict/domain";
import type { DatasetRegistry } from "../ports/dataset-registry.js";
import { deleteVersionedResource, deleteVersionedResources } from "../versioned-resource/versioned-resource-delete.js";

// Dataset-version deletion — the shared creator-or-admin mechanics live in versioned-resource-delete.ts
// (review §23: five byte-identical copies of one policy); these wrappers keep the resource's PUBLIC
// vocabulary concrete for both transports (BFF↔MCP parity).

const KIND = { permission: "datasets:delete", noun: "dataset" } as const;

export function deleteDatasetVersion(
  registry: DatasetRegistry,
  principal: Principal,
  id: string,
  version: string,
): Promise<{ workspace: string; id: string; version: string; deleted: true }> {
  return deleteVersionedResource(registry, KIND, principal, id, version);
}

export function deleteDatasetVersions(
  registry: DatasetRegistry,
  principal: Principal,
  id: string,
  versions?: readonly string[],
): Promise<{ workspace: string; id: string; deleted: string[] }> {
  return deleteVersionedResources(registry, KIND, principal, id, versions);
}
