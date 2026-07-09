import { ConflictError, type JudgeSpec, NotFoundError } from "@everdict/core";
import { SHARED_TENANT, compareVersions, resolveRef, specsEqual } from "../registry.js";

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

// Latest JudgeSpec → list-derived fields. model=provider/model, harness=→harness delegation.
export function judgeDerived(
  spec: JudgeSpec,
): Pick<JudgeListEntry, "kind" | "provider" | "model" | "description" | "subtitle"> {
  if (spec.kind === "model") {
    return {
      kind: "model",
      provider: spec.provider,
      model: spec.model,
      ...(spec.description !== undefined ? { description: spec.description } : {}),
      subtitle: `${spec.provider}/${spec.model}`,
    };
  }
  return {
    kind: "harness",
    ...(spec.description !== undefined ? { description: spec.description } : {}),
    subtitle: `→ ${spec.harness.id}`,
  };
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

interface Entry {
  spec: JudgeSpec;
  seq: number;
  createdAt: string;
  createdBy?: string;
  tags?: string[]; // version tags — mutable registry metadata (outside spec immutability, on par with createdBy)
}

export class InMemoryJudgeRegistry implements JudgeRegistry {
  private readonly byOwner = new Map<string, Map<string, Map<string, Entry>>>(); // tenant → id → version → Entry
  private seq = 0;

  private ownerVersions(owner: string, id: string): string[] {
    const ids = this.byOwner.get(owner)?.get(id);
    if (!ids) return [];
    return [...ids.values()]
      .sort((a, b) => compareVersions(a.spec.version, b.spec.version) || a.seq - b.seq)
      .map((e) => e.spec.version);
  }
  private ownerOf(tenant: string, id: string): string | undefined {
    if (this.byOwner.get(tenant)?.has(id)) return tenant;
    if (this.byOwner.get(SHARED_TENANT)?.has(id)) return SHARED_TENANT;
    return undefined;
  }

  async register(tenant: string, spec: JudgeSpec, createdBy?: string): Promise<void> {
    let ids = this.byOwner.get(tenant);
    if (!ids) {
      ids = new Map();
      this.byOwner.set(tenant, ids);
    }
    let versions = ids.get(spec.id);
    if (!versions) {
      versions = new Map();
      ids.set(spec.id, versions);
    }
    const existing = versions.get(spec.version);
    if (existing) {
      if (!specsEqual(existing.spec, spec)) {
        throw new ConflictError(
          "CONFLICT",
          { tenant, id: spec.id, version: spec.version },
          `judge ${spec.id}@${spec.version} is already registered with different content (versions are immutable).`,
        );
      }
      return;
    }
    versions.set(spec.version, {
      spec,
      seq: this.seq++,
      createdAt: new Date().toISOString(),
      ...(createdBy !== undefined ? { createdBy } : {}),
    });
  }

  async has(tenant: string, id: string, version: string): Promise<boolean> {
    const owner = this.ownerOf(tenant, id);
    return owner ? (this.byOwner.get(owner)?.get(id)?.has(version) ?? false) : false;
  }

  async versions(tenant: string, id: string): Promise<string[]> {
    const owner = this.ownerOf(tenant, id);
    return owner ? this.ownerVersions(owner, id) : [];
  }

  async ownVersions(tenant: string, id: string): Promise<string[]> {
    return this.ownerVersions(tenant, id); // exactly this tenant's own (no fallback)
  }

  async get(tenant: string, id: string, ref = "latest"): Promise<JudgeSpec> {
    const owner = this.ownerOf(tenant, id);
    if (!owner) throw new NotFoundError("NOT_FOUND", { tenant, id }, `judge '${id}' not found.`);
    const version = resolveRef(id, ref, this.ownerVersions(owner, id));
    return (this.byOwner.get(owner)?.get(id)?.get(version) as Entry).spec;
  }

  async list(tenant: string): Promise<JudgeListEntry[]> {
    const ids = new Map<string, string>(); // id → owner (tenant first)
    for (const id of this.byOwner.get(SHARED_TENANT)?.keys() ?? []) ids.set(id, SHARED_TENANT);
    for (const id of this.byOwner.get(tenant)?.keys() ?? []) ids.set(id, tenant);
    const out: JudgeListEntry[] = [];
    for (const [id, owner] of [...ids.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const versions = this.ownerVersions(owner, id);
      const latestVersion = versions.at(-1);
      if (latestVersion === undefined) continue;
      const entries = [...(this.byOwner.get(owner)?.get(id)?.values() ?? [])].sort((a, b) => a.seq - b.seq);
      const earliest = entries[0];
      const latest = entries.at(-1);
      const latestSpec = this.byOwner.get(owner)?.get(id)?.get(latestVersion)?.spec;
      const versionTags = await this.versionTags(owner, id);
      out.push({
        id,
        owner,
        versions,
        latestVersion,
        versionCount: versions.length,
        ...(latestSpec ? judgeDerived(latestSpec) : {}),
        ...(earliest?.createdBy !== undefined ? { createdBy: earliest.createdBy } : {}),
        ...(earliest ? { createdAt: earliest.createdAt } : {}),
        ...(latest ? { updatedAt: latest.createdAt } : {}),
        ...(Object.keys(versionTags).length > 0 ? { versionTags } : {}),
      });
    }
    return out;
  }

  async setVersionTags(tenant: string, id: string, version: string, tags: string[]): Promise<void> {
    const entry = this.byOwner.get(tenant)?.get(id)?.get(version); // directly-owned only (no fallback — _shared can't be tagged)
    if (!entry) throw new NotFoundError("NOT_FOUND", { tenant, id, version }, `judge ${id}@${version} not found.`);
    entry.tags = tags.length > 0 ? tags : undefined; // empty array = remove (same idiom as revive's deletedAt=undefined)
  }

  async versionTags(tenant: string, id: string): Promise<Record<string, string[]>> {
    const owner = this.ownerOf(tenant, id);
    if (!owner) return {};
    const out: Record<string, string[]> = {};
    for (const e of this.byOwner.get(owner)?.get(id)?.values() ?? []) {
      if (e.tags !== undefined && e.tags.length > 0) out[e.spec.version] = e.tags;
    }
    return out;
  }
}
