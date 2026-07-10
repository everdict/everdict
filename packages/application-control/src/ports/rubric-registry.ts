import type { RubricSpec } from "@everdict/contracts";

// One list entry — version metadata (registration history) + display fields derived from the latest rubric spec (description/subtitle).
// GET /rubrics and MCP list_rubrics emit this shape. Same feel as the judge/dataset ListEntry.
export interface RubricListEntry {
  id: string;
  owner: string;
  versions: string[];
  latestVersion: string;
  versionCount: number;
  description?: string; // rubric description (spec field)
  subtitle?: string; // content summary (text · N criteria · template) — list subtitle
  createdBy?: string; // subject of the first-registered version (absent for seed/_shared)
  createdAt?: string;
  updatedAt?: string;
  versionTags?: Record<string, string[]>; // version → free-form label (tagged versions only) — mutable registry metadata (outside the spec)
}

// Rubric version SSOT — (tenant, id, version) → RubricSpec. Versions are immutable. "latest" is the semver/registration-order latest.
// Same ownership model as judges/datasets: tenant-owned first, else SHARED_TENANT (first-party default rubric) fallback.
// One rubric serves many judges (JudgeSpec.rubric may reference it as {id, version}). async — Postgres honors the same contract.
export interface RubricRegistry {
  register(tenant: string, spec: RubricSpec, createdBy?: string): Promise<void>;
  has(tenant: string, id: string, version: string): Promise<boolean>;
  get(tenant: string, id: string, ref?: string): Promise<RubricSpec>;
  versions(tenant: string, id: string): Promise<string[]>; // sorted (semver first) — owner-first / _shared fallback
  ownVersions(tenant: string, id: string): Promise<string[]>; // only versions this tenant registered directly (no fallback — for conflict checks)
  list(tenant: string): Promise<RubricListEntry[]>;
  // Version tags (free-form labels, full replacement) — mutable registry metadata (outside spec immutability). Tenant-owned versions only; _shared → NotFound.
  setVersionTags(tenant: string, id: string, version: string, tags: string[]): Promise<void>;
  // version → tag map (tagged versions only). Reads resolve owner like versions() (incl. _shared fallback).
  versionTags(tenant: string, id: string): Promise<Record<string, string[]>>;
}
