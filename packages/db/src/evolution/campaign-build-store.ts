import type { CampaignBuildStore, OutboxEvent } from "@everdict/application-control";
import {
  type CampaignBuildRecord,
  CampaignBuildRecordSchema,
  type CampaignBuildSetRecord,
  CampaignBuildSetRecordSchema,
} from "@everdict/contracts";
import type { SqlClient } from "../client.js";
import { EVENT_COLUMNS, eventValuesClause } from "../results/outbox.js";

// ── THE CAMPAIGN BUILD STORE (docs/architecture/code-evolution-loop.md, D2) ──────────────────────────
//
// Everdict's ledger of turning a commit into a candidate image in its own managed store. Both twins make the
// SAME decisions — the settle writes are CONDITIONAL on `building`, so a unit test over the in-memory store
// exercises the refusal a production Postgres would give (rule `testing`). Facts ride the same write via the
// E0 outbox `events` parameter, exactly as the campaign store carries theirs.

export class InMemoryCampaignBuildStore implements CampaignBuildStore {
  private readonly byId = new Map<string, CampaignBuildRecord>();
  private readonly sets = new Map<string, CampaignBuildSetRecord>();
  private readonly events: OutboxEvent[] = [];

  async createSet(record: CampaignBuildSetRecord, events?: OutboxEvent[]): Promise<void> {
    if (this.sets.has(record.id)) throw new Error(`campaign build set ${record.id} already exists`);
    this.sets.set(record.id, record);
    if (events) this.events.push(...events);
  }

  async getSet(tenant: string, id: string): Promise<CampaignBuildSetRecord | undefined> {
    const record = this.sets.get(id);
    return record && record.tenant === tenant ? record : undefined;
  }

  async setsForCampaign(tenant: string, campaignId: string): Promise<CampaignBuildSetRecord[]> {
    return [...this.sets.values()]
      .filter((r) => r.tenant === tenant && r.campaignId === campaignId)
      .sort((a, b) =>
        a.createdAt === b.createdAt ? b.id.localeCompare(a.id) : b.createdAt.localeCompare(a.createdAt),
      );
  }

  // The SAME decision the Pg statement makes: exactly one caller moves `building → minting`.
  async claimMint(
    tenant: string,
    setId: string,
    at: string,
  ): Promise<"claimed" | "already_claimed" | "not_building" | "absent"> {
    // ATOMIC WITHIN ONE TURN: no await between the read and the transition. Postgres makes this decision in one
    // UPDATE; a twin that yields between its read and its write hands two concurrent drivers the same claim,
    // and the build-set counterexample (two drivers, one mint) caught exactly that.
    const record = this.sets.get(setId);
    if (record === undefined || record.tenant !== tenant) return "absent";
    if (record.state === "minting") return "already_claimed";
    if (record.state !== "building") return "not_building";
    this.sets.set(setId, { ...record, state: "minting", updatedAt: at });
    return "claimed";
  }

  async settleSet(
    tenant: string,
    setId: string,
    outcome:
      | { state: "minted"; candidateVersion: string; images: Record<string, string>; sha: string; at: string }
      | { state: "failed"; error: string; at: string },
    events?: OutboxEvent[],
  ): Promise<"settled" | "not_settleable" | "absent"> {
    const record = await this.getSet(tenant, setId);
    if (record === undefined) return "absent";
    const allowed =
      outcome.state === "minted"
        ? record.state === "minting"
        : record.state === "building" || record.state === "minting";
    if (!allowed) return "not_settleable";
    this.sets.set(
      setId,
      outcome.state === "minted"
        ? {
            ...record,
            state: "minted",
            candidateVersion: outcome.candidateVersion,
            images: outcome.images,
            sha: outcome.sha,
            updatedAt: outcome.at,
          }
        : { ...record, state: "failed", error: outcome.error, updatedAt: outcome.at },
    );
    if (events) this.events.push(...events);
    return "settled";
  }

  async create(record: CampaignBuildRecord, events?: OutboxEvent[]): Promise<void> {
    if (this.byId.has(record.id)) throw new Error(`campaign build ${record.id} already exists`);
    this.byId.set(record.id, record);
    if (events) this.events.push(...events);
  }

  async get(tenant: string, id: string): Promise<CampaignBuildRecord | undefined> {
    const record = this.byId.get(id);
    return record && record.tenant === tenant ? record : undefined; // another workspace reads as nonexistent
  }

  async forCampaign(tenant: string, campaignId: string): Promise<CampaignBuildRecord[]> {
    return [...this.byId.values()]
      .filter((r) => r.tenant === tenant && r.campaignId === campaignId)
      .sort((a, b) =>
        a.createdAt === b.createdAt ? b.id.localeCompare(a.id) : b.createdAt.localeCompare(a.createdAt),
      );
  }

  async complete(
    tenant: string,
    id: string,
    result: {
      sha: string;
      image: NonNullable<CampaignBuildRecord["image"]>;
      candidateVersion?: string;
      receipt: NonNullable<CampaignBuildRecord["receipt"]>;
      at: string;
    },
    events?: OutboxEvent[],
  ): Promise<"completed" | "not_building" | "absent"> {
    const record = await this.get(tenant, id);
    if (record === undefined) return "absent";
    if (record.state !== "building") return "not_building";
    this.byId.set(id, {
      ...record,
      state: "built",
      source: { ...record.source, sha: result.sha },
      image: result.image,
      ...(result.candidateVersion !== undefined ? { candidateVersion: result.candidateVersion } : {}),
      receipt: result.receipt,
      updatedAt: result.at,
    });
    if (events) this.events.push(...events);
    return "completed";
  }

  async fail(
    tenant: string,
    id: string,
    failure: { error: string; sha?: string; at: string },
    events?: OutboxEvent[],
  ): Promise<"failed" | "not_building" | "absent"> {
    const record = await this.get(tenant, id);
    if (record === undefined) return "absent";
    if (record.state !== "building") return "not_building";
    this.byId.set(id, {
      ...record,
      state: "failed",
      ...(failure.sha !== undefined ? { source: { ...record.source, sha: failure.sha } } : {}),
      error: failure.error,
      updatedAt: failure.at,
    });
    if (events) this.events.push(...events);
    return "failed";
  }

  outbox(): OutboxEvent[] {
    return [...this.events];
  }
}

interface BuildRow {
  id: string;
  tenant: string;
  record: unknown;
}

const toRecord = (row: BuildRow): CampaignBuildRecord => CampaignBuildRecordSchema.parse(row.record);

export class PgCampaignBuildStore implements CampaignBuildStore {
  constructor(private readonly client: SqlClient) {}

  async create(record: CampaignBuildRecord, events?: OutboxEvent[]): Promise<void> {
    const base = [record.id, record.tenant, record.campaignId, record.state, JSON.stringify(record), record.createdAt];
    const cols = "(id, tenant, campaign_id, state, record, created_at, updated_at)";
    const vals = "($1, $2, $3, $4, $5::jsonb, $6::timestamptz, $6::timestamptz)";
    if (events && events.length > 0) {
      const ev = eventValuesClause(events, base.length + 1);
      await this.client.query(
        `WITH ins AS (INSERT INTO everdict_campaign_builds ${cols} VALUES ${vals} RETURNING id)
         INSERT INTO everdict_platform_events ${EVENT_COLUMNS}
         SELECT * FROM (VALUES ${ev.sql}) AS v WHERE EXISTS (SELECT 1 FROM ins)`,
        [...base, ...ev.params],
      );
      return;
    }
    await this.client.query(`INSERT INTO everdict_campaign_builds ${cols} VALUES ${vals}`, base);
  }

  async get(tenant: string, id: string): Promise<CampaignBuildRecord | undefined> {
    const { rows } = await this.client.query<BuildRow>(
      "SELECT id, tenant, record FROM everdict_campaign_builds WHERE tenant=$1 AND id=$2",
      [tenant, id],
    );
    return rows[0] ? toRecord(rows[0]) : undefined;
  }

  async forCampaign(tenant: string, campaignId: string): Promise<CampaignBuildRecord[]> {
    const { rows } = await this.client.query<BuildRow>(
      "SELECT id, tenant, record FROM everdict_campaign_builds WHERE tenant=$1 AND campaign_id=$2 ORDER BY created_at DESC, id DESC",
      [tenant, campaignId],
    );
    return rows.map(toRecord);
  }

  // The settle rewrites the whole document and flips `state`, CONDITIONAL on `building` in the WHERE — the
  // decision consumes the write's answer rather than assuming it (rule `protocol`, conditional writes).
  private async settle<L extends "completed" | "failed">(
    tenant: string,
    id: string,
    next: CampaignBuildRecord,
    events: OutboxEvent[] | undefined,
    landed: L,
  ): Promise<L | "not_building" | "absent"> {
    const base = [tenant, id, next.state, JSON.stringify(next), next.updatedAt];
    const ev = events && events.length > 0 ? eventValuesClause(events, base.length + 1) : undefined;
    const { rows } = await this.client.query<{ id: string }>(
      `WITH upd AS (
         UPDATE everdict_campaign_builds SET state=$3, record=$4::jsonb, updated_at=$5::timestamptz
          WHERE tenant=$1 AND id=$2 AND state='building'
          RETURNING id
       )${
         ev !== undefined
           ? `, ev AS (INSERT INTO everdict_platform_events ${EVENT_COLUMNS}
              SELECT * FROM (VALUES ${ev.sql}) AS v WHERE EXISTS (SELECT 1 FROM upd))`
           : ""
       }
       SELECT id FROM upd`,
      ev !== undefined ? [...base, ...ev.params] : base,
    );
    if (rows[0] !== undefined) return landed;
    const { rows: readback } = await this.client.query<{ state: string }>(
      "SELECT state FROM everdict_campaign_builds WHERE tenant=$1 AND id=$2",
      [tenant, id],
    );
    return readback[0] === undefined ? "absent" : "not_building";
  }

  async complete(
    tenant: string,
    id: string,
    result: {
      sha: string;
      image: NonNullable<CampaignBuildRecord["image"]>;
      candidateVersion?: string;
      receipt: NonNullable<CampaignBuildRecord["receipt"]>;
      at: string;
    },
    events?: OutboxEvent[],
  ): Promise<"completed" | "not_building" | "absent"> {
    const record = await this.get(tenant, id);
    if (record === undefined) return "absent";
    if (record.state !== "building") return "not_building";
    const next: CampaignBuildRecord = {
      ...record,
      state: "built",
      source: { ...record.source, sha: result.sha },
      image: result.image,
      ...(result.candidateVersion !== undefined ? { candidateVersion: result.candidateVersion } : {}),
      receipt: result.receipt,
      updatedAt: result.at,
    };
    return this.settle(tenant, id, next, events, "completed");
  }

  // ── THE BUILD SET (evolution-routing-spec.md §4) — the claim lives in the statement's WHERE ────────
  async createSet(record: CampaignBuildSetRecord, events?: OutboxEvent[]): Promise<void> {
    const base = [record.id, record.tenant, record.campaignId, record.state, JSON.stringify(record), record.createdAt];
    const cols = "(id, tenant, campaign_id, state, record, created_at, updated_at)";
    const vals = "($1, $2, $3, $4, $5::jsonb, $6::timestamptz, $6::timestamptz)";
    if (events && events.length > 0) {
      const ev = eventValuesClause(events, base.length + 1);
      await this.client.query(
        `WITH ins AS (INSERT INTO everdict_campaign_build_sets ${cols} VALUES ${vals} RETURNING id)
         INSERT INTO everdict_platform_events ${EVENT_COLUMNS}
         SELECT * FROM (VALUES ${ev.sql}) AS v WHERE EXISTS (SELECT 1 FROM ins)`,
        [...base, ...ev.params],
      );
      return;
    }
    await this.client.query(`INSERT INTO everdict_campaign_build_sets ${cols} VALUES ${vals}`, base);
  }

  async getSet(tenant: string, id: string): Promise<CampaignBuildSetRecord | undefined> {
    const { rows } = await this.client.query<{ record: unknown }>(
      "SELECT record FROM everdict_campaign_build_sets WHERE tenant=$1 AND id=$2",
      [tenant, id],
    );
    return rows[0] ? CampaignBuildSetRecordSchema.parse(rows[0].record) : undefined;
  }

  async setsForCampaign(tenant: string, campaignId: string): Promise<CampaignBuildSetRecord[]> {
    const { rows } = await this.client.query<{ record: unknown }>(
      "SELECT record FROM everdict_campaign_build_sets WHERE tenant=$1 AND campaign_id=$2 ORDER BY created_at DESC, id DESC",
      [tenant, campaignId],
    );
    return rows.map((r) => CampaignBuildSetRecordSchema.parse(r.record));
  }

  // Exactly one caller moves `building → minting`: the transition is the statement's WHERE, and a caller that
  // moved no row reads the state back to say which refusal it met.
  async claimMint(
    tenant: string,
    setId: string,
    at: string,
  ): Promise<"claimed" | "already_claimed" | "not_building" | "absent"> {
    const { rows } = await this.client.query<{ id: string }>(
      `UPDATE everdict_campaign_build_sets
          SET state='minting', record = record || jsonb_build_object('state', 'minting', 'updatedAt', $3::text), updated_at=$3::timestamptz
        WHERE tenant=$1 AND id=$2 AND state='building'
        RETURNING id`,
      [tenant, setId, at],
    );
    if (rows[0] !== undefined) return "claimed";
    const { rows: readback } = await this.client.query<{ state: string }>(
      "SELECT state FROM everdict_campaign_build_sets WHERE tenant=$1 AND id=$2",
      [tenant, setId],
    );
    if (readback[0] === undefined) return "absent";
    return readback[0].state === "minting" ? "already_claimed" : "not_building";
  }

  async settleSet(
    tenant: string,
    setId: string,
    outcome:
      | { state: "minted"; candidateVersion: string; images: Record<string, string>; sha: string; at: string }
      | { state: "failed"; error: string; at: string },
    events?: OutboxEvent[],
  ): Promise<"settled" | "not_settleable" | "absent"> {
    const record = await this.getSet(tenant, setId);
    if (record === undefined) return "absent";
    const next: CampaignBuildSetRecord =
      outcome.state === "minted"
        ? {
            ...record,
            state: "minted",
            candidateVersion: outcome.candidateVersion,
            images: outcome.images,
            sha: outcome.sha,
            updatedAt: outcome.at,
          }
        : { ...record, state: "failed", error: outcome.error, updatedAt: outcome.at };
    const from = outcome.state === "minted" ? "('minting')" : "('building','minting')";
    const base = [tenant, setId, next.state, JSON.stringify(next), next.updatedAt];
    const ev = events && events.length > 0 ? eventValuesClause(events, base.length + 1) : undefined;
    const { rows } = await this.client.query<{ id: string }>(
      `WITH upd AS (
         UPDATE everdict_campaign_build_sets SET state=$3, record=$4::jsonb, updated_at=$5::timestamptz
          WHERE tenant=$1 AND id=$2 AND state IN ${from}
          RETURNING id
       )${
         ev !== undefined
           ? `, ev AS (INSERT INTO everdict_platform_events ${EVENT_COLUMNS}
              SELECT * FROM (VALUES ${ev.sql}) AS v WHERE EXISTS (SELECT 1 FROM upd))`
           : ""
       }
       SELECT id FROM upd`,
      ev !== undefined ? [...base, ...ev.params] : base,
    );
    return rows[0] !== undefined ? "settled" : "not_settleable";
  }

  async fail(
    tenant: string,
    id: string,
    failure: { error: string; sha?: string; at: string },
    events?: OutboxEvent[],
  ): Promise<"failed" | "not_building" | "absent"> {
    const record = await this.get(tenant, id);
    if (record === undefined) return "absent";
    if (record.state !== "building") return "not_building";
    const next: CampaignBuildRecord = {
      ...record,
      state: "failed",
      ...(failure.sha !== undefined ? { source: { ...record.source, sha: failure.sha } } : {}),
      error: failure.error,
      updatedAt: failure.at,
    };
    return this.settle(tenant, id, next, events, "failed");
  }
}
