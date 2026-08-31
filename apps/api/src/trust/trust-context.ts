import { type PgPool, type SqlClient, makePool, migrate, sqlClient } from "@everdict/db";

// Shared gate + real-Postgres wiring for the trust suite (docs/trust-certification.md).
//
// The suite certifies invariants that a fake cannot prove: SQL-clock lease races, cross-replica admission
// over one ledger, a store round-trip that has to survive serialization. Those need a REAL database, so the
// files that use one are gated on having got one.
//
// Two env vars, deliberately separate:
//   EVERDICT_TRUST_SUITE=1        — run the trust suite at all (absent ⇒ `pnpm test` stays fast and green)
//   EVERDICT_TRUST_DATABASE_URL   — the Postgres the Pg-backed scenarios drive (falls back to DATABASE_URL)
//
// A missing database SKIPS rather than fails, because a developer running one scenario locally should not be
// forced to boot Postgres. The nightly closes that hole from the outside: scripts/trust/trust-suite.mjs
// refuses to certify unless every expected scenario actually RAN, so "silently skipped everything" can never
// read as PASS.
export const TRUST_SUITE_ENABLED = process.env.EVERDICT_TRUST_SUITE === "1";

const DATABASE_URL = process.env.EVERDICT_TRUST_DATABASE_URL ?? process.env.DATABASE_URL;

export const TRUST_PG_ENABLED = TRUST_SUITE_ENABLED && DATABASE_URL !== undefined && DATABASE_URL !== "";

// The ClickHouse lane, gated the same way and for the same reason. Its resolution rules are SQL — an
// `argMin(x, (rank, clock))` either orders the way the store claims or it does not, and MergeTree's lack of a
// unique key means every read has to collapse duplicate rows itself. Neither is answerable by a fake that
// echoes the query text back.
//   EVERDICT_TRUST_CLICKHOUSE_URL — e.g. http://127.0.0.1:8123
const CLICKHOUSE_URL = process.env.EVERDICT_TRUST_CLICKHOUSE_URL;

export const TRUST_CH_ENABLED = TRUST_SUITE_ENABLED && CLICKHOUSE_URL !== undefined && CLICKHOUSE_URL !== "";

export function trustClickHouseUrl(): string {
  if (CLICKHOUSE_URL === undefined || CLICKHOUSE_URL === "")
    throw new Error(
      "trustClickHouseUrl called without EVERDICT_TRUST_CLICKHOUSE_URL — guard the describe with TRUST_CH_ENABLED",
    );
  return CLICKHOUSE_URL;
}

// Send a statement straight to ClickHouse. The scenarios need this to SET UP states the store deliberately
// cannot produce — two attempts that both passed the seal's pre-read and both wrote rows, which is the race
// the resolution exists to answer.
export async function trustClickHouseCommand(sql: string, body?: string): Promise<string> {
  const url = new URL(trustClickHouseUrl());
  url.searchParams.set("query", sql);
  const res = await fetch(url, { method: "POST", body: body ?? "" });
  const text = await res.text();
  if (!res.ok) throw new Error(`ClickHouse refused: ${res.status} ${text}`);
  return text;
}

export interface TrustPg {
  client: SqlClient;
  pool: PgPool;
  close(): Promise<void>;
}

// Open a pool against the trust database and bring the schema up. `migrate` is idempotent by contract, so
// every file may call this; the first one pays for the DDL.
export async function openTrustPg(): Promise<TrustPg> {
  if (DATABASE_URL === undefined || DATABASE_URL === "")
    throw new Error(
      "openTrustPg called without EVERDICT_TRUST_DATABASE_URL — guard the describe with TRUST_PG_ENABLED",
    );
  const pool = makePool(DATABASE_URL);
  const client = sqlClient(pool);
  await migrate(client);
  return { client, pool, close: () => pool.end() };
}

// Per-run identity so concurrent scenarios (and reruns against a database that keeps its rows) never collide
// on a lease role, a replica id or a record id.
export function trustId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
