import type { HarnessInstanceSpec, HarnessSpec, ServiceHarnessSpec } from "@everdict/contracts";
import type { HarnessTemplateRegistry } from "./harness-template-registry.js";

// List metadata — live-version summary for one id (from registration history). Spec derivations like category/kind are filled in by the upstream registry.
export interface VersionMeta {
  id: string;
  owner: string;
  versions: string[];
  latestVersion: string;
  versionCount: number;
  createdBy?: string; // subject of the first registered version
  latestCreatedBy?: string; // subject of the latest (semver) version — the privacy owner for a user-secret harness (visibility follows the version that decides privacy)
  createdAt?: string; // first registration time (ISO)
  updatedAt?: string; // most recent registration time (ISO)
  versionTags?: Record<string, string[]>; // version → tags (empty versions omitted; if no tags at all, the field itself is omitted)
}

// One list entry — version meta (registration history) + display fields derived from the latest instance (category/kind/subtitle).
// GET /harnesses and MCP list_harnesses produce this shape. Same grain as the dataset DatasetListEntry.
export interface HarnessListEntry extends VersionMeta {
  category?: string; // template category of the latest instance (cli-agent, etc.)
  kind?: string; // command | service | process (resolved)
  subtitle?: string; // model/command/service summary (a harness has no free-text description, so this serves as the subtitle)
  // true if the latest instance references a user-scoped secret — this harness is visible to createdBy only (private).
  // The API uses this value + createdBy to hide it from other users in list/detail (the value itself is derived — not stored separately).
  private?: boolean;
}

// Individual harness (instance) registry — (tenant, id, version) → HarnessInstanceSpec (template reference + pins).
// get()/getService() pin the template and return a resolved HarnessSpec (drop-in compatible with the existing HarnessRegistry.get).
// Instances stack as versions under the same id (= template.id) → list groups them by category (template).
export interface HarnessInstanceRegistry {
  register(tenant: string, instance: HarnessInstanceSpec, createdBy?: string): Promise<void>;
  has(tenant: string, id: string, version: string): Promise<boolean>;
  getInstance(tenant: string, id: string, ref?: string): Promise<HarnessInstanceSpec>;
  get(tenant: string, id: string, ref?: string): Promise<HarnessSpec>; // resolved (template + pins)
  // resolved + submit-time transient pins (registry unchanged) — when a CI PR trigger swaps just one service image to evaluate.
  resolveWithPins(
    tenant: string,
    id: string,
    ref: string | undefined,
    pins: Record<string, string>,
  ): Promise<HarnessSpec>;
  getService(tenant: string, id: string, ref?: string): Promise<ServiceHarnessSpec>;
  versions(tenant: string, id: string): Promise<string[]>;
  list(tenant: string): Promise<HarnessListEntry[]>;
  // The first-registrant subject of this harness id (no seed/shared) — for verifying the owner of a private (references a personal secret) harness.
  creatorOf(tenant: string, id: string): Promise<string | undefined>;
  // The registrant subject of this "version" — for delete authz (creator-or-admin). Non-owned/deleted/absent → NotFound (same as datasets).
  creatorOfVersion(tenant: string, id: string, version: string): Promise<string | undefined>;
  // Version soft-delete (tombstone) — data is preserved (past scorecard reproducibility), excluded from every read, re-registering identical content revives it.
  softDelete(tenant: string, id: string, version: string): Promise<void>;
  // Version tags (free-form labels, full replacement) — mutable registry meta (outside spec immutability). Tenant-owned live versions only; _shared → NotFound.
  setVersionTags(tenant: string, id: string, version: string, tags: string[]): Promise<void>;
  // version → tags map (only versions with tags). Reads resolve owner like versions() (including _shared fallback).
  versionTags(tenant: string, id: string): Promise<Record<string, string[]>>;
}
