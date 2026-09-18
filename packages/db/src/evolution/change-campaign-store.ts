import type { ChangeCampaignStore } from "@everdict/application-control";
import {
  type ChangeCampaignClose,
  type ChangeCampaignRecord,
  ChangeCampaignRecordSchema,
  type ChangeRound,
} from "@everdict/contracts";
import type { SqlClient } from "../client.js";

// The `change` grade of campaign — the same contract in-memory and on Postgres (migration 0218).
//
// Rounds append under a guard and the close happens once. Both return a BOOLEAN the caller must consume: the
// alternative is a store that reports success for a race it lost, which is how two agents working the same
// request end up with one of their rounds missing and nothing anywhere saying so.

export class InMemoryChangeCampaignStore implements ChangeCampaignStore {
  private readonly byId = new Map<string, ChangeCampaignRecord>();

  async create(record: ChangeCampaignRecord): Promise<void> {
    this.byId.set(record.id, record);
  }

  async get(tenant: string, id: string): Promise<ChangeCampaignRecord | undefined> {
    const record = this.byId.get(id);
    return record && record.tenant === tenant ? record : undefined; // another workspace's reads as nonexistent
  }

  async list(tenant: string, options?: { issueId?: string; limit?: number }): Promise<ChangeCampaignRecord[]> {
    return [...this.byId.values()]
      .filter((r) => r.tenant === tenant && (options?.issueId === undefined || r.issueId === options.issueId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, options?.limit ?? 200);
  }

  async count(tenant: string, options?: { issueId?: string }): Promise<number> {
    return [...this.byId.values()].filter(
      (r) => r.tenant === tenant && (options?.issueId === undefined || r.issueId === options.issueId),
    ).length;
  }

  async appendRound(
    tenant: string,
    id: string,
    round: ChangeRound,
    expectedRounds: number,
    at: string,
  ): Promise<boolean> {
    const record = await this.get(tenant, id);
    if (!record || record.state !== "open" || record.rounds.length !== expectedRounds) return false;
    this.byId.set(id, { ...record, rounds: [...record.rounds, round], updatedAt: at });
    return true;
  }

  async close(tenant: string, id: string, close: ChangeCampaignClose, at: string): Promise<boolean> {
    const record = await this.get(tenant, id);
    if (!record || record.state !== "open") return false;
    this.byId.set(id, { ...record, state: close.state, close, updatedAt: at });
    return true;
  }
}

interface Row {
  id: string;
  tenant: string;
  body: unknown;
}

const parse = (row: Row): ChangeCampaignRecord =>
  ChangeCampaignRecordSchema.parse(typeof row.body === "string" ? JSON.parse(row.body) : row.body);

export class PgChangeCampaignStore implements ChangeCampaignStore {
  constructor(private readonly sql: SqlClient) {}

  async create(record: ChangeCampaignRecord): Promise<void> {
    await this.sql.query(
      `INSERT INTO everdict_change_campaigns
         (id, tenant, issue_id, repository, state, round_count, created_by, created_at, updated_at, body)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        record.id,
        record.tenant,
        record.issueId,
        record.service.repository,
        record.state,
        record.rounds.length,
        record.createdBy,
        record.createdAt,
        record.updatedAt,
        JSON.stringify(record),
      ],
    );
  }

  async get(tenant: string, id: string): Promise<ChangeCampaignRecord | undefined> {
    const { rows } = await this.sql.query<Row>(
      "SELECT id, tenant, body FROM everdict_change_campaigns WHERE tenant = $1 AND id = $2",
      [tenant, id],
    );
    const row = rows[0];
    return row ? parse(row) : undefined;
  }

  async list(tenant: string, options?: { issueId?: string; limit?: number }): Promise<ChangeCampaignRecord[]> {
    const { rows } = await this.sql.query<Row>(
      `SELECT id, tenant, body FROM everdict_change_campaigns
        WHERE tenant = $1 AND ($2::text IS NULL OR issue_id = $2)
        ORDER BY created_at DESC
        LIMIT $3`,
      [tenant, options?.issueId ?? null, options?.limit ?? 200],
    );
    return rows.map(parse);
  }

  // The same WHERE as `list`, without the page. Counted in the database rather than by reading the rows: the
  // point of the projection is that this read never materializes 1,905 lines of round bodies again.
  async count(tenant: string, options?: { issueId?: string }): Promise<number> {
    const { rows } = await this.sql.query<{ count: string | number }>(
      `SELECT count(*) AS count FROM everdict_change_campaigns
        WHERE tenant = $1 AND ($2::text IS NULL OR issue_id = $2)`,
      [tenant, options?.issueId ?? null],
    );
    const row = rows[0];
    return row === undefined ? 0 : Number(row.count);
  }

  // The guard lives in the WHERE clause, not in a read-then-write: `round_count = $3` is the compare, the
  // jsonb append is the swap, and a loser updates zero rows rather than clobbering the winner's round.
  async appendRound(
    tenant: string,
    id: string,
    round: ChangeRound,
    expectedRounds: number,
    at: string,
  ): Promise<boolean> {
    // RETURNING, because this client reports affected rows only as rows: a conditional write whose outcome
    // is inferred from anything else is a write that cannot say it lost.
    const { rows } = await this.sql.query(
      `UPDATE everdict_change_campaigns
          SET body = jsonb_set(
                jsonb_set(body, '{rounds}', (body->'rounds') || $4::jsonb, true),
                '{updatedAt}', to_jsonb($5::text), true),
              round_count = round_count + 1,
              -- Cast, because the same parameter is pinned to TEXT above by to_jsonb: Postgres infers a
              -- parameter's type from its FIRST use, and the timestamptz column then refuses it. Found by
              -- running this against a real database — a fake SqlClient binds nothing, so it cannot
              -- disagree about a type it never sent.
              updated_at = $5::timestamptz
        WHERE tenant = $1 AND id = $2 AND state = 'open' AND round_count = $3
        RETURNING id`,
      [tenant, id, expectedRounds, JSON.stringify([round]), at],
    );
    return rows.length > 0;
  }

  async close(tenant: string, id: string, close: ChangeCampaignClose, at: string): Promise<boolean> {
    const { rows } = await this.sql.query(
      `UPDATE everdict_change_campaigns
          SET body = jsonb_set(
                jsonb_set(
                  jsonb_set(body, '{close}', $4::jsonb, true),
                  '{state}', to_jsonb($3::text), true),
                '{updatedAt}', to_jsonb($5::text), true),
              state = $3,
              updated_at = $5::timestamptz
        WHERE tenant = $1 AND id = $2 AND state = 'open'
        RETURNING id`,
      [tenant, id, close.state, JSON.stringify(close), at],
    );
    return rows.length > 0;
  }
}
