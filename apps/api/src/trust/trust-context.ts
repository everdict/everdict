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
