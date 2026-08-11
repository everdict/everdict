#!/usr/bin/env node
// One SIDE of the settle race (docs/trust-certification.md — TRUST-135).
//
// A separate OS process on purpose. Two writers inside one Node process share an event loop, so their
// "race" is an interleaving this repository's own scheduler decides; the thing under test is a condition
// evaluated by POSTGRES while two independent connections are in flight. That needs two processes.
//
// It settles one run and prints, as JSON, whether the database let it. Nothing else — the assertions live in
// the scenario that spawned it.
import { PgRunStore, makePool, sqlClient } from "../../packages/db/dist/index.js";

const [runId, status, code] = process.argv.slice(2);
const startAt = Number(process.env.RACE_START_AT ?? "0");
const url = process.env.DATABASE_URL ?? "";
if (!runId || !status || !url) {
  console.error("usage: settle-race-child.mjs <runId> <status> <errorCode>  (DATABASE_URL required)");
  process.exit(2);
}

const pool = makePool(url);
const runs = new PgRunStore(sqlClient(pool));

// Both children wake at the same wall-clock instant the parent chose, so neither is systematically first.
// Which one wins is not the claim — that exactly one does, and that the row agrees with it, is.
const wait = startAt - Date.now();
if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));

const written = await runs.update(
  runId,
  {
    status,
    ...(code ? { error: { code, message: `settled by ${code}` } } : {}),
    updatedAt: new Date().toISOString(),
  },
  undefined,
  // The guard under test: this row is still open to being settled, decided at the instant of the write.
  { expectNonTerminal: true },
);
console.log(JSON.stringify({ status, won: written !== undefined }));
await pool.end();
