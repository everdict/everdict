import {
  type CapabilityRecord,
  CapabilityRecordSchema,
  type CapabilityVisibility,
  ConflictError,
} from "@everdict/contracts";
import { canConsumeCapability, compareVersions, resolveRef, specsEqual } from "@everdict/domain";

import type { CapabilityStore } from "@everdict/application-control";

import type { SqlClient } from "../client.js";

// Capability Store impls — one discriminated versioned entity (mcp|code|skill|environment). Versioned like the registry
// [(tenant,id,version) immutable + soft-delete] but with per-capability VISIBILITY (private|workspace|subset|public)
// instead of the `_shared` fallback. Same contract, InMemory (dev/tests) + Pg (DATABASE_URL). See docs/architecture/capability-store.md.

const keyOf = (tenant: string, id: string, version: string): string => `${tenant}\u0000${id}\u0000${version}`;

// The content that version immutability guards — name/description/spec. visibility/sharedWith/tags/createdBy/createdAt
// are mutable metadata (outside specsEqual), so re-registering the same content with a promoted reach is not a conflict.
const contentOf = (r: CapabilityRecord): unknown => ({ name: r.name, description: r.description, spec: r.spec });

// Reduce to the latest live version per (tenant, id), newest-registered first (the browse shape).
function latestPerId(records: CapabilityRecord[]): CapabilityRecord[] {
  const byId = new Map<string, CapabilityRecord>();
  for (const r of records) {
    const k = `${r.tenant}\u0000${r.id}`;
    const cur = byId.get(k);
    if (!cur || compareVersions(r.version, cur.version) > 0) byId.set(k, r);
  }
  return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

interface Entry {
  record: CapabilityRecord;
  deletedAt?: number;
}

export class InMemoryCapabilityStore implements CapabilityStore {
  private readonly byKey = new Map<string, Entry>();

  async register(record: CapabilityRecord): Promise<void> {
    const existing = this.byKey.get(keyOf(record.tenant, record.id, record.version));
    if (existing) {
      if (!specsEqual(contentOf(existing.record), contentOf(record))) {
        throw new ConflictError(
          "CONFLICT",
          { tenant: record.tenant, id: record.id, version: record.version },
          `Capability ${record.id}@${record.version} is already registered with different content (versions are immutable).`,
        );
      }
      existing.deletedAt = undefined; // identical content → revive
      return;
    }
    this.byKey.set(keyOf(record.tenant, record.id, record.version), { record });
  }

  private liveEntriesOf(tenant: string, id: string): Entry[] {
    return [...this.byKey.values()].filter(
      (e) => e.record.tenant === tenant && e.record.id === id && e.deletedAt === undefined,
    );
  }

  private liveRecords(): CapabilityRecord[] {
    return [...this.byKey.values()].filter((e) => e.deletedAt === undefined).map((e) => e.record);
  }

  async versions(tenant: string, id: string): Promise<string[]> {
    return this.liveEntriesOf(tenant, id)
      .map((e) => e.record.version)
      .sort((a, b) => compareVersions(a, b) || a.localeCompare(b));
  }

  async setVersionTags(tenant: string, id: string, version: string, tags: string[]): Promise<void> {
    const e = this.byKey.get(keyOf(tenant, id, version));
    if (e && e.deletedAt === undefined) e.record = { ...e.record, tags };
  }

  async versionTags(tenant: string, id: string): Promise<Record<string, string[]>> {
    const out: Record<string, string[]> = {};
    for (const e of this.liveEntriesOf(tenant, id)) {
      if (e.record.tags.length > 0) out[e.record.version] = e.record.tags;
    }
    return out;
  }

  async get(tenant: string, id: string, ref = "latest"): Promise<CapabilityRecord | undefined> {
    const versions = await this.versions(tenant, id);
    if (versions.length === 0) return undefined;
    try {
      const version = resolveRef(id, ref, versions);
      return this.byKey.get(keyOf(tenant, id, version))?.record;
    } catch {
      return undefined; // unknown ref → not found (undefined, like the other stores' get)
    }
  }

  async getVersion(owner: string, id: string, version: string): Promise<CapabilityRecord | undefined> {
    const e = this.byKey.get(keyOf(owner, id, version));
    return e && e.deletedAt === undefined ? e.record : undefined;
  }

  async listVisible(tenant: string, subject: string): Promise<CapabilityRecord[]> {
    return latestPerId(
      this.liveRecords().filter(
        (r) =>
          (r.tenant === tenant && canConsumeCapability(r, { tenant, subject })) || // own private(mine)/workspace/subset/public
          (r.visibility === "subset" && r.sharedWith.includes(tenant)), // subset shared to me from another workspace
      ),
    );
  }

  async listPublic(): Promise<CapabilityRecord[]> {
    return latestPerId(this.liveRecords().filter((r) => r.visibility === "public"));
  }

  async setVisibility(
    tenant: string,
    id: string,
    next: { visibility: CapabilityVisibility; sharedWith: string[] },
  ): Promise<void> {
    for (const e of this.liveEntriesOf(tenant, id)) {
      e.record = { ...e.record, visibility: next.visibility, sharedWith: next.sharedWith };
    }
  }

  async softDelete(tenant: string, id: string, version: string): Promise<void> {
    const e = this.byKey.get(keyOf(tenant, id, version));
    if (e && e.deletedAt === undefined) e.deletedAt = Date.now();
  }

  async creatorOfVersion(tenant: string, id: string, version: string): Promise<string | undefined> {
    const e = this.byKey.get(keyOf(tenant, id, version));
    return e && e.deletedAt === undefined ? e.record.createdBy : undefined;
  }
}

interface CapabilityRow {
  tenant: string;
  id: string;
  version: string;
  name: string;
  description: string;
  spec: unknown;
  visibility: string;
  shared_with: unknown;
  tags: unknown;
  created_by: string;
  created_at: string | Date;
}

const iso = (v: string | Date): string => (typeof v === "string" ? v : v.toISOString());

function rowToRecord(row: CapabilityRow): CapabilityRecord {
  return CapabilityRecordSchema.parse({
    id: row.id,
    tenant: row.tenant,
    version: row.version,
    name: row.name,
    description: row.description,
    spec: row.spec,
    visibility: row.visibility,
    sharedWith: row.shared_with,
    tags: row.tags,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
  });
}

// Postgres capability store — same contract as in-memory. spec/shared_with/tags are jsonb; the visibility SQL mirrors
// the canConsumeCapability kernel exactly.
export class PgCapabilityStore implements CapabilityStore {
  constructor(private readonly client: SqlClient) {}

  // ── THE INSERT IS THE ARBITER, NOT THE SELECT ABOVE IT ─────────────────────────────────────────
  //
  // This read the row, decided "absent", and INSERTed. `(tenant, id, version)` is the primary key, so two
  // concurrent registrations of the same brand-new version both saw absent and both inserted — one of them
  // met a unique violation that left this store as a RAW database error, which the error model forbids
  // ("external failures are remapped to our AppError so monitoring blames us, not the user"). Both outcomes
  // were wrong in a way the caller could not act on: an idempotent re-register of identical content became a
  // 500, and a genuine content conflict arrived as a driver error instead of this store's own 409.
  //
  // `ON CONFLICT DO NOTHING RETURNING 1` moves the decision to the statement the engine arbitrates. Zero rows
  // back means somebody else holds the key — which is the SAME situation the SELECT above found, so it is
  // answered by the same code rather than by a second policy. Reported by `pnpm scan` over `adapters` at low
  // confidence, and confidence is the scanner rating itself: the window is narrow and the shape is real.
  async register(record: CapabilityRecord): Promise<void> {
    // The existing-row decision, spent by both the pre-read and the lost-race arm. One reading of "this
    // version is already here", or the two drift and only one of them is tested.
    const settleAgainstExisting = async (): Promise<void> => {
      const { rows } = await this.client.query<CapabilityRow>(
        "SELECT * FROM everdict_capabilities WHERE tenant=$1 AND id=$2 AND version=$3",
        [record.tenant, record.id, record.version],
      );
      const existing = rows[0];
      // Nothing there after the insert reported a conflict is not a state this store can explain: the key was
      // taken a moment ago. Refuse rather than fall through to a second insert that would race the same way.
      if (!existing)
        throw new ConflictError(
          "CONFLICT",
          { tenant: record.tenant, id: record.id, version: record.version },
          `Capability ${record.id}@${record.version} could not be registered and could not be read back — retry.`,
        );
      if (!specsEqual(contentOf(rowToRecord(existing)), contentOf(record))) {
        throw new ConflictError(
          "CONFLICT",
          { tenant: record.tenant, id: record.id, version: record.version },
          `Capability ${record.id}@${record.version} is already registered with different content (versions are immutable).`,
        );
      }
      // Identical content re-registered: revive the tombstone, which is what makes this idempotent.
      await this.client.query(
        "UPDATE everdict_capabilities SET deleted_at=NULL WHERE tenant=$1 AND id=$2 AND version=$3",
        [record.tenant, record.id, record.version],
      );
    };

    const inserted = await this.client.query<{ ok: number }>(
      `INSERT INTO everdict_capabilities
       (tenant, id, version, type, name, description, spec, visibility, shared_with, tags, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (tenant, id, version) DO NOTHING
       RETURNING 1 AS ok`,
      [
        record.tenant,
        record.id,
        record.version,
        record.spec.type,
        record.name,
        record.description,
        JSON.stringify(record.spec),
        record.visibility,
        JSON.stringify(record.sharedWith),
        JSON.stringify(record.tags),
        record.createdBy,
        record.createdAt,
      ],
    );
    if (inserted.rows.length > 0) return;
    await settleAgainstExisting();
  }

  private async liveRows(tenant: string, id: string): Promise<CapabilityRow[]> {
    const { rows } = await this.client.query<CapabilityRow>(
      "SELECT * FROM everdict_capabilities WHERE tenant=$1 AND id=$2 AND deleted_at IS NULL",
      [tenant, id],
    );
    return rows;
  }

  async versions(tenant: string, id: string): Promise<string[]> {
    const rows = await this.liveRows(tenant, id);
    return rows.map((r) => r.version).sort((a, b) => compareVersions(a, b) || a.localeCompare(b));
  }

  async setVersionTags(tenant: string, id: string, version: string, tags: string[]): Promise<void> {
    await this.client.query(
      "UPDATE everdict_capabilities SET tags=$4 WHERE tenant=$1 AND id=$2 AND version=$3 AND deleted_at IS NULL",
      [tenant, id, version, JSON.stringify(tags)],
    );
  }

  async versionTags(tenant: string, id: string): Promise<Record<string, string[]>> {
    const rows = await this.liveRows(tenant, id);
    const out: Record<string, string[]> = {};
    for (const row of rows) {
      const record = rowToRecord(row);
      if (record.tags.length > 0) out[record.version] = record.tags;
    }
    return out;
  }

  async get(tenant: string, id: string, ref = "latest"): Promise<CapabilityRecord | undefined> {
    const rows = await this.liveRows(tenant, id);
    if (rows.length === 0) return undefined;
    const versions = rows.map((r) => r.version).sort((a, b) => compareVersions(a, b) || a.localeCompare(b));
    try {
      const version = resolveRef(id, ref, versions);
      const row = rows.find((r) => r.version === version);
      return row ? rowToRecord(row) : undefined;
    } catch {
      return undefined;
    }
  }

  async getVersion(owner: string, id: string, version: string): Promise<CapabilityRecord | undefined> {
    const { rows } = await this.client.query<CapabilityRow>(
      "SELECT * FROM everdict_capabilities WHERE tenant=$1 AND id=$2 AND version=$3 AND deleted_at IS NULL",
      [owner, id, version],
    );
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async listVisible(tenant: string, subject: string): Promise<CapabilityRecord[]> {
    // Mirrors canConsumeCapability: own workspace/subset/public + own private(mine) + subset shared to me. Excludes the
    // global public catalog from OTHER tenants (that is listPublic).
    const { rows } = await this.client.query<CapabilityRow>(
      `SELECT * FROM everdict_capabilities
       WHERE deleted_at IS NULL AND (
         (tenant=$1 AND (visibility IN ('workspace','subset','public') OR created_by=$2))
         OR (visibility='subset' AND shared_with @> to_jsonb($1::text))
       )`,
      [tenant, subject],
    );
    return latestPerId(rows.map(rowToRecord));
  }

  async listPublic(): Promise<CapabilityRecord[]> {
    const { rows } = await this.client.query<CapabilityRow>(
      "SELECT * FROM everdict_capabilities WHERE deleted_at IS NULL AND visibility='public'",
      [],
    );
    return latestPerId(rows.map(rowToRecord));
  }

  async setVisibility(
    tenant: string,
    id: string,
    next: { visibility: CapabilityVisibility; sharedWith: string[] },
  ): Promise<void> {
    await this.client.query(
      "UPDATE everdict_capabilities SET visibility=$3, shared_with=$4 WHERE tenant=$1 AND id=$2 AND deleted_at IS NULL",
      [tenant, id, next.visibility, JSON.stringify(next.sharedWith)],
    );
  }

  async softDelete(tenant: string, id: string, version: string): Promise<void> {
    await this.client.query(
      "UPDATE everdict_capabilities SET deleted_at=now() WHERE tenant=$1 AND id=$2 AND version=$3 AND deleted_at IS NULL",
      [tenant, id, version],
    );
  }

  async creatorOfVersion(tenant: string, id: string, version: string): Promise<string | undefined> {
    const { rows } = await this.client.query<{ created_by: string }>(
      "SELECT created_by FROM everdict_capabilities WHERE tenant=$1 AND id=$2 AND version=$3 AND deleted_at IS NULL",
      [tenant, id, version],
    );
    return rows[0]?.created_by;
  }
}
