import type { JudgeSpec } from "@everdict/contracts";

// One list entry — version metadata (registration history) + display fields derived from the latest judge spec (kind/provider/model/description).
// GET /judges and MCP list_judges emit this shape. Same feel as the dataset/harness ListEntry.
export interface JudgeListEntry {
  id: string;
  owner: string;
  versions: string[];
  latestVersion: string;
  versionCount: number;
  kind?: string; // model | harness (category role)
  provider?: string; // model judge: anthropic | openai
  model?: string; // model judge: model id
  description?: string; // judge description (spec field)
  subtitle?: string; // provider/model or →harness summary (list subtitle)
  createdBy?: string; // subject of the first-registered version (absent for seed/_shared)
  createdAt?: string;
  updatedAt?: string;
  versionTags?: Record<string, string[]>; // version → free-form label (tagged versions only) — mutable registry metadata (outside the spec)
}

// Agent Judge version SSOT — (tenant, id, version) → JudgeSpec. Versions are immutable. "latest" is the semver/registration-order latest.
// Same ownership model as harnesses/datasets: tenant-owned first, else SHARED_TENANT (first-party default judge) fallback.
// A user registers and version-manages their own judge (model/harness) directly. async — Postgres honors the same contract.
export interface JudgeRegistry {
  register(tenant: string, spec: JudgeSpec, createdBy?: string): Promise<void>;
  has(tenant: string, id: string, version: string): Promise<boolean>;
  get(tenant: string, id: string, ref?: string): Promise<JudgeSpec>;
  versions(tenant: string, id: string): Promise<string[]>; // sorted (semver first) — owner-first / _shared fallback
  ownVersions(tenant: string, id: string): Promise<string[]>; // only versions this tenant registered directly (no fallback — for conflict checks)
  list(tenant: string): Promise<JudgeListEntry[]>;
  // Version tags (free-form labels, full replacement) — mutable registry metadata (outside spec immutability). Tenant-owned versions only; _shared → NotFound.
  setVersionTags(tenant: string, id: string, version: string, tags: string[]): Promise<void>;
  // version → tag map (tagged versions only). Reads resolve owner like versions() (incl. _shared fallback).
  versionTags(tenant: string, id: string): Promise<Record<string, string[]>>;
}
