import type { Dataset, DatasetProvenance } from "@everdict/contracts";

// One list() entry — summarizes a single id (with several immutable versions) into list-view metadata. Content
// (case count / description / tags / provenance) comes from the latest semver version; creator and timestamps come
// from the registration history (createdAt=first registration, updatedAt=latest registration).
// _shared and file-seeded versions have no createdBy (undefined). GET /datasets and MCP list_datasets emit this shape verbatim.
export interface DatasetListEntry {
  id: string;
  owner: string;
  versions: string[]; // live versions (semver ascending)
  latestVersion: string; // latest semver version (source of the content fields below)
  caseCount: number; // case count of the latest version
  tags: string[]; // tags of the latest version
  description?: string; // description of the latest version (if any)
  producedBy?: DatasetProvenance; // ingest provenance of the latest version (recipe/catalog/spec; if any)
  createdBy?: string; // creator subject of the first-registered version (none for seed/_shared)
  createdAt?: string; // when the first version was registered (ISO)
  updatedAt?: string; // when the most recent version was registered (ISO)
  // Version tags — version → free-form label (only versions that have tags). Unlike content tags (entity classification),
  // these are registry metadata editable after registration (attached when versions are hard to tell apart by number alone).
  versionTags?: Record<string, string[]>;
}

// Dataset version SSOT — (tenant, id, version) → Dataset. Versions are immutable. "latest" = newest by semver/registration order.
// Same ownership model as the harness registry: tenant-owned first, else SHARED_TENANT (first-party benchmark) fallback.
// Harness-agnostic — the same dataset runs against several harness@version for baseline comparison. async — Postgres shares the contract.
export interface DatasetRegistry {
  // createdBy: subject that registered this version (for soft-delete authz — the creator themselves). No system seed / file loader (undefined).
  register(tenant: string, dataset: Dataset, createdBy?: string): Promise<void>;
  has(tenant: string, id: string, version: string): Promise<boolean>;
  get(tenant: string, id: string, ref?: string): Promise<Dataset>;
  versions(tenant: string, id: string): Promise<string[]>; // sorted (semver first) — owner-first / _shared fallback, deleted versions excluded
  ownVersions(tenant: string, id: string): Promise<string[]>; // only versions this tenant registered directly (no fallback — for conflict checks), deleted versions excluded
  list(tenant: string): Promise<DatasetListEntry[]>;
  // Creator subject of a live version this tenant directly owns (undefined if none). Missing/deleted/non-owned version → NotFound — no fallback.
  creatorOf(tenant: string, id: string, version: string): Promise<string | undefined>;
  // Soft delete (tombstone) — preserve the data but exclude it from reads (keeps reproducibility). Tenant directly-owned only; missing/already-deleted version → NotFound.
  softDelete(tenant: string, id: string, version: string): Promise<void>;
  // Version tags (free-form label, full replacement) — mutable registry metadata (outside content immutability). Tenant-owned live versions only; _shared → NotFound.
  setVersionTags(tenant: string, id: string, version: string, tags: string[]): Promise<void>;
  // version → tags map (only versions that have tags). Reads resolve owner the same as versions() (including _shared fallback).
  versionTags(tenant: string, id: string): Promise<Record<string, string[]>>;
}
