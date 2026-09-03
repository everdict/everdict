import type { CreatedWorldRecord, CreatedWorldState, WorldCreationStore } from "@everdict/application-control";
import { CreatedWorldRecordSchema } from "@everdict/application-control";
import type { SqlClient } from "../client.js";

// ── THE LEDGER OF WORLDS THIS PLATFORM MADE (world-and-engagement-model.md, landing order 3.9) ───────
//
// Two implementations of one port, and both must answer the question the reconciler asks: what is still
// owed. A `released` row never comes back — it is the only terminal, and it is written only after a
// read-back said the world is not standing.

export class InMemoryWorldCreationStore implements WorldCreationStore {
  private readonly rows = new Map<string, CreatedWorldRecord>();
  private key(tenant: string, id: string): string {
    return `${tenant}::${id}`;
  }

  async open(record: Omit<CreatedWorldRecord, "state" | "attempts" | "updatedAt">): Promise<CreatedWorldRecord> {
    const row: CreatedWorldRecord = { ...record, state: "creating", attempts: 0, updatedAt: record.createdAt };
    this.rows.set(this.key(record.tenant, record.id), row);
    return row;
  }

  async transition(
    tenant: string,
    id: string,
    to: CreatedWorldState,
    detail?: { detail?: string; bumpAttempts?: boolean },
  ): Promise<boolean> {
    const row = this.rows.get(this.key(tenant, id));
    // A row that is already `released` is done: re-settling it would let a late sweep overwrite a verified
    // ending with a guess — the same first-terminal-wins rule every other ledger here keeps.
    if (row === undefined || row.state === "released") return false;
    this.rows.set(this.key(tenant, id), {
      ...row,
      state: to,
      attempts: row.attempts + (detail?.bumpAttempts === true ? 1 : 0),
      ...(detail?.detail !== undefined ? { detail: detail.detail } : {}),
      updatedAt: new Date().toISOString(),
    });
    return true;
  }

  async get(tenant: string, id: string): Promise<CreatedWorldRecord | undefined> {
    return this.rows.get(this.key(tenant, id));
  }

  async due(now: string, staleBeforeMs: number): Promise<CreatedWorldRecord[]> {
    const cutoff = Date.parse(now) - staleBeforeMs;
    return [...this.rows.values()].filter((row) => {
      if (row.state === "released") return false;
      // `unknown` and `releasing` are owed immediately — something already tried and could not finish. A row
      // still `creating`/`created` is owed only once STALE, because the case that owns it may still be
      // running and sweeping it would tear the world out from under a live agent.
      if (row.state === "unknown" || row.state === "releasing") return true;
      return Date.parse(row.updatedAt) <= cutoff;
    });
  }
}

// Postgres twin. Schema: @everdict/db/migrations/0208_created_worlds.
export class PgWorldCreationStore implements WorldCreationStore {
  constructor(private readonly client: SqlClient) {}

  async open(record: Omit<CreatedWorldRecord, "state" | "attempts" | "updatedAt">): Promise<CreatedWorldRecord> {
    const rows = await this.client.query<Record<string, unknown>>(
      `INSERT INTO everdict_created_worlds (id, tenant, run_id, environment, target, state, services, attempts, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'creating', $6::jsonb, 0, $7, $7)
       RETURNING id, tenant, run_id, environment, target, state, services, attempts, detail, created_at, updated_at`,
      [
        record.id,
        record.tenant,
        record.runId,
        record.environment,
        record.target ?? null,
        JSON.stringify(record.services),
        record.createdAt,
      ],
    );
    const row = rows.rows[0];
    // The insert returned nothing, so nothing is recorded — and a caller may not create a world it could not
    // record (rule `protocol` L1). Throwing here IS the refusal.
    if (row === undefined)
      throw new Error(`the created-world ledger did not record ${record.id} — the world was not created`);
    return parse(row);
  }

  async transition(
    tenant: string,
    id: string,
    to: CreatedWorldState,
    detail?: { detail?: string; bumpAttempts?: boolean },
  ): Promise<boolean> {
    // One statement, with `state <> 'released'` in the WHERE: a verified ending is never overwritten by a
    // later sweep's guess, and the affected-row count is the answer (never a read-then-write).
    const rows = await this.client.query<{ id: string }>(
      `UPDATE everdict_created_worlds
          SET state = $3,
              detail = COALESCE($4, detail),
              attempts = attempts + $5,
              updated_at = now()
        WHERE tenant = $1 AND id = $2 AND state <> 'released'
        RETURNING id`,
      [tenant, id, to, detail?.detail ?? null, detail?.bumpAttempts === true ? 1 : 0],
    );
    return rows.rows.length > 0;
  }

  async get(tenant: string, id: string): Promise<CreatedWorldRecord | undefined> {
    const rows = await this.client.query<Record<string, unknown>>(
      `SELECT id, tenant, run_id, environment, target, state, services, attempts, detail, created_at, updated_at
         FROM everdict_created_worlds WHERE tenant = $1 AND id = $2`,
      [tenant, id],
    );
    const row = rows.rows[0];
    return row === undefined ? undefined : parse(row);
  }

  async due(now: string, staleBeforeMs: number): Promise<CreatedWorldRecord[]> {
    const cutoff = new Date(Date.parse(now) - staleBeforeMs).toISOString();
    const rows = await this.client.query<Record<string, unknown>>(
      `SELECT id, tenant, run_id, environment, target, state, services, attempts, detail, created_at, updated_at
         FROM everdict_created_worlds
        WHERE state <> 'released'
          AND (state IN ('unknown', 'releasing') OR updated_at <= $1)
        ORDER BY updated_at ASC
        LIMIT 200`,
      [cutoff],
    );
    return rows.rows.map(parse);
  }
}

function parse(row: Record<string, unknown>): CreatedWorldRecord {
  const at = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
  return CreatedWorldRecordSchema.parse({
    id: row.id,
    tenant: row.tenant,
    runId: row.run_id,
    environment: row.environment,
    ...(row.target != null ? { target: String(row.target) } : {}),
    state: row.state,
    services: row.services ?? [],
    attempts: Number(row.attempts ?? 0),
    ...(row.detail != null ? { detail: String(row.detail) } : {}),
    createdAt: at(row.created_at),
    updatedAt: at(row.updated_at),
  });
}
