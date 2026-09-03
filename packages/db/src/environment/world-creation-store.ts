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
  // sharedKey → the row that IS that world, so two cases asking for the same world find one row.
  private readonly shared = new Map<string, string>();
  private key(tenant: string, id: string): string {
    return `${tenant}::${id}`;
  }

  async open(
    record: Omit<
      CreatedWorldRecord,
      "state" | "attempts" | "updatedAt" | "holders" | "sharedKey" | "endpoints" | "expiresAt"
    >,
  ): Promise<CreatedWorldRecord> {
    const row: CreatedWorldRecord = {
      ...record,
      state: "creating",
      attempts: 0,
      holders: 0,
      updatedAt: record.createdAt,
    };
    this.rows.set(this.key(record.tenant, record.id), row);
    return row;
  }

  async transition(
    tenant: string,
    id: string,
    to: CreatedWorldState,
    detail?: { detail?: string; bumpAttempts?: boolean; endpoints?: Record<string, string> },
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
      ...(detail?.endpoints !== undefined ? { endpoints: detail.endpoints } : {}),
      updatedAt: new Date().toISOString(),
    });
    return true;
  }

  async get(tenant: string, id: string): Promise<CreatedWorldRecord | undefined> {
    return this.rows.get(this.key(tenant, id));
  }

  // ── JOINING A SHARED WORLD, ATOMICALLY ─────────────────────────────────────────────────────────
  //
  // No `await` between the read and the write. The Pg twin does this in ONE statement, and a twin that
  // yielded here would let two cases both believe they are first — the exact interleaving this method
  // exists to decide, and the exact bug an in-memory double is most likely to hide (rule `testing`).
  async acquireShared(input: {
    id: string;
    tenant: string;
    runId: string;
    environment: string;
    sharedKey: string;
    services: unknown[];
    target?: string;
    expiresAt: string;
    now: string;
  }): Promise<{ row: CreatedWorldRecord; created: boolean }> {
    const key = this.sharedIndex(input.tenant, input.sharedKey);
    const existing = this.shared.get(key);
    const live = existing !== undefined ? this.rows.get(this.key(input.tenant, existing)) : undefined;
    if (live !== undefined && live.state !== "released") {
      const row: CreatedWorldRecord = { ...live, holders: live.holders + 1, expiresAt: input.expiresAt };
      this.rows.set(this.key(row.tenant, row.id), row);
      return { row, created: false };
    }
    // A released world's NAME is free (the Pg twin's unique index excludes released rows), so what follows is
    // an ordinary create: a new row, a new world, and the settled one left standing as history. Nothing
    // joins it and no statement has to tell "I revived it" from "I joined it".
    const row: CreatedWorldRecord = {
      id: input.id,
      tenant: input.tenant,
      runId: input.runId,
      environment: input.environment,
      ...(input.target !== undefined ? { target: input.target } : {}),
      sharedKey: input.sharedKey,
      holders: 1,
      expiresAt: input.expiresAt,
      state: "creating",
      services: input.services,
      attempts: 0,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.rows.set(this.key(row.tenant, row.id), row);
    this.shared.set(key, row.id);
    return { row, created: true };
  }

  async releaseShared(
    tenant: string,
    sharedKey: string,
  ): Promise<{ row: CreatedWorldRecord; holders: number } | undefined> {
    const id = this.shared.get(this.sharedIndex(tenant, sharedKey));
    const row = id !== undefined ? this.rows.get(this.key(tenant, id)) : undefined;
    if (row === undefined) return undefined;
    const holders = Math.max(0, row.holders - 1);
    const next = { ...row, holders, updatedAt: new Date().toISOString() };
    this.rows.set(this.key(tenant, row.id), next);
    return { row: next, holders };
  }

  async getShared(tenant: string, sharedKey: string): Promise<CreatedWorldRecord | undefined> {
    const id = this.shared.get(this.sharedIndex(tenant, sharedKey));
    return id === undefined ? undefined : this.rows.get(this.key(tenant, id));
  }

  private sharedIndex(tenant: string, sharedKey: string): string {
    return `${tenant}::shared::${sharedKey}`;
  }

  async due(now: string, staleBeforeMs: number): Promise<CreatedWorldRecord[]> {
    const cutoff = Date.parse(now) - staleBeforeMs;
    return [...this.rows.values()].filter((row) => {
      if (row.state === "released") return false;
      // `unknown` and `releasing` are owed immediately — something already tried and could not finish. A row
      // still `creating`/`created` is owed only once STALE, because the case that owns it may still be
      // running and sweeping it would tear the world out from under a live agent.
      if (row.state === "unknown" || row.state === "releasing") return true;
      // A SHARED world is held by its refcount, not by its clock: it is owed when nobody is inside it, or
      // when its lease expired (a holder that died without leaving). Sweeping a live one on staleness alone
      // would tear a world out from under a case that is still acting on it — worse than a leak, because the
      // number that comes back looks like an ordinary failure.
      if (row.sharedKey !== undefined)
        return (
          (row.holders === 0 && Date.parse(row.updatedAt) <= cutoff) ||
          (row.expiresAt !== undefined && Date.parse(row.expiresAt) <= Date.parse(now))
        );
      return Date.parse(row.updatedAt) <= cutoff;
    });
  }
}

// Postgres twin. Schema: @everdict/db/migrations/0208_created_worlds.
export class PgWorldCreationStore implements WorldCreationStore {
  constructor(private readonly client: SqlClient) {}

  async open(
    record: Omit<
      CreatedWorldRecord,
      "state" | "attempts" | "updatedAt" | "holders" | "sharedKey" | "endpoints" | "expiresAt"
    >,
  ): Promise<CreatedWorldRecord> {
    const rows = await this.client.query<Record<string, unknown>>(
      `INSERT INTO everdict_created_worlds (id, tenant, run_id, environment, target, state, services, attempts, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'creating', $6::jsonb, 0, $7, $7)
       RETURNING id, tenant, run_id, environment, target, state, services, attempts, shared_key, holders, expires_at, endpoints, detail, created_at, updated_at`,
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
    detail?: { detail?: string; bumpAttempts?: boolean; endpoints?: Record<string, string> },
  ): Promise<boolean> {
    // One statement, with `state <> 'released'` in the WHERE: a verified ending is never overwritten by a
    // later sweep's guess, and the affected-row count is the answer (never a read-then-write).
    const rows = await this.client.query<{ id: string }>(
      `UPDATE everdict_created_worlds
          SET state = $3,
              detail = COALESCE($4, detail),
              attempts = attempts + $5,
              endpoints = COALESCE($6::jsonb, endpoints),
              updated_at = now()
        WHERE tenant = $1 AND id = $2 AND state <> 'released'
        RETURNING id`,
      [
        tenant,
        id,
        to,
        detail?.detail ?? null,
        detail?.bumpAttempts === true ? 1 : 0,
        detail?.endpoints !== undefined ? JSON.stringify(detail.endpoints) : null,
      ],
    );
    return rows.rows.length > 0;
  }

  async get(tenant: string, id: string): Promise<CreatedWorldRecord | undefined> {
    const rows = await this.client.query<Record<string, unknown>>(
      `SELECT id, tenant, run_id, environment, target, state, services, attempts, shared_key, holders, expires_at, endpoints, detail, created_at, updated_at
         FROM everdict_created_worlds WHERE tenant = $1 AND id = $2`,
      [tenant, id],
    );
    const row = rows.rows[0];
    return row === undefined ? undefined : parse(row);
  }

  // ── JOINING A SHARED WORLD, IN ONE STATEMENT ───────────────────────────────────────────────────
  //
  // The whole decision — "is there a live world for this key, and am I the one who must create it" — is the
  // INSERT's own conflict arm. Two cases arriving at the same instant therefore get two different answers
  // from the database rather than the same answer from two reads: the loser's insert conflicts, its arm
  // increments the holder count, and `xmax = 0` is Postgres telling the winner that the row is the one it
  // just inserted (a read-then-write here is the race, not a style question).
  //
  // The arbiter index excludes RELEASED rows, so a key whose world was torn down conflicts with nothing and
  // this is an ordinary insert: a second batch reusing the name gets a new world and a new row, and `mine`
  // stays the one fact the statement can state without ambiguity — "this row is the row I just inserted".
  async acquireShared(input: {
    id: string;
    tenant: string;
    runId: string;
    environment: string;
    sharedKey: string;
    services: unknown[];
    target?: string;
    expiresAt: string;
    now: string;
  }): Promise<{ row: CreatedWorldRecord; created: boolean }> {
    const rows = await this.client.query<Record<string, unknown>>(
      `INSERT INTO everdict_created_worlds
         (id, tenant, run_id, environment, target, state, services, attempts, shared_key, holders, expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'creating', $6::jsonb, 0, $7, 1, $8, $9, $9)
       ON CONFLICT (tenant, shared_key) WHERE shared_key IS NOT NULL AND state <> 'released' DO UPDATE
         SET holders = everdict_created_worlds.holders + 1,
             expires_at = EXCLUDED.expires_at,
             updated_at = now()
       RETURNING id, tenant, run_id, environment, target, state, services, attempts, shared_key, holders, expires_at, endpoints, detail, created_at, updated_at,
                 (xmax = 0) AS mine`,
      [
        input.id,
        input.tenant,
        input.runId,
        input.environment,
        input.target ?? null,
        JSON.stringify(input.services),
        input.sharedKey,
        input.expiresAt,
        input.now,
      ],
    );
    const row = rows.rows[0];
    if (row === undefined)
      throw new Error(`the created-world ledger did not record the shared world ${input.sharedKey}`);
    return { row: parse(row), created: row.mine === true };
  }

  async releaseShared(
    tenant: string,
    sharedKey: string,
  ): Promise<{ row: CreatedWorldRecord; holders: number } | undefined> {
    const rows = await this.client.query<Record<string, unknown>>(
      `UPDATE everdict_created_worlds
          SET holders = GREATEST(0, holders - 1), updated_at = now()
        WHERE tenant = $1 AND shared_key = $2
        RETURNING id, tenant, run_id, environment, target, state, services, attempts, shared_key, holders, expires_at, endpoints, detail, created_at, updated_at`,
      [tenant, sharedKey],
    );
    const row = rows.rows[0];
    if (row === undefined) return undefined;
    const parsed = parse(row);
    return { row: parsed, holders: parsed.holders };
  }

  async getShared(tenant: string, sharedKey: string): Promise<CreatedWorldRecord | undefined> {
    const rows = await this.client.query<Record<string, unknown>>(
      `SELECT id, tenant, run_id, environment, target, state, services, attempts, shared_key, holders, expires_at, endpoints, detail, created_at, updated_at
         FROM everdict_created_worlds WHERE tenant = $1 AND shared_key = $2`,
      [tenant, sharedKey],
    );
    const row = rows.rows[0];
    return row === undefined ? undefined : parse(row);
  }

  async due(now: string, staleBeforeMs: number): Promise<CreatedWorldRecord[]> {
    const cutoff = new Date(Date.parse(now) - staleBeforeMs).toISOString();
    const rows = await this.client.query<Record<string, unknown>>(
      `SELECT id, tenant, run_id, environment, target, state, services, attempts, shared_key, holders, expires_at, endpoints, detail, created_at, updated_at
         FROM everdict_created_worlds
        WHERE state <> 'released'
          AND (
            state IN ('unknown', 'releasing')
            -- A SHARED world is held by its refcount, not by its clock: owed when nobody is inside it, or
            -- when its lease expired (a holder that died without leaving). Sweeping a live one on staleness
            -- alone would tear a world out from under a case still acting on it.
            OR (shared_key IS NOT NULL AND ((holders = 0 AND updated_at <= $1) OR expires_at <= $2))
            OR (shared_key IS NULL AND updated_at <= $1)
          )
        ORDER BY updated_at ASC
        LIMIT 200`,
      [cutoff, now],
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
    ...(row.shared_key != null ? { sharedKey: String(row.shared_key) } : {}),
    holders: Number(row.holders ?? 0),
    ...(row.expires_at != null ? { expiresAt: at(row.expires_at) } : {}),
    ...(row.endpoints != null ? { endpoints: row.endpoints } : {}),
    state: row.state,
    services: row.services ?? [],
    attempts: Number(row.attempts ?? 0),
    ...(row.detail != null ? { detail: String(row.detail) } : {}),
    createdAt: at(row.created_at),
    updatedAt: at(row.updated_at),
  });
}
