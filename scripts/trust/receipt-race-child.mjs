#!/usr/bin/env node
// One SIDE of the case-commit race (docs/trust-certification.md — TRUST-169).
//
// A separate OS process on purpose, for the same reason the settle race needs one: two claimants inside one
// Node process share an event loop, so their "race" is an interleaving this repository's own scheduler
// decides. The thing under test is a decision POSTGRES makes while two independent connections are in
// flight — which is the situation an at-least-once workflow and a recovery are actually in.
//
// It claims one case for one child run and prints, as JSON, whether it won and whose receipt now owns the
// case. Nothing else — the assertions live in the scenario that spawned it.
import { PgCaseReceiptStore, makePool, sqlClient } from "../../packages/db/dist/index.js";

const [scorecardId, caseId, childRunId, trialArg] = process.argv.slice(2);
const trial = Number(trialArg ?? "0");
const startAt = Number(process.env.RACE_START_AT ?? "0");
const url = process.env.DATABASE_URL ?? "";
if (!scorecardId || !caseId || !childRunId || !url) {
  console.error("usage: receipt-race-child.mjs <scorecardId> <caseId> <childRunId> [trial]  (DATABASE_URL required)");
  process.exit(2);
}

const pool = makePool(url);
const receipts = new PgCaseReceiptStore(sqlClient(pool));

// Both children wake at the same wall-clock instant the parent chose, so neither is systematically first.
// Which one wins is not the claim — that exactly one does, and that both agree about who, is.
const wait = startAt - Date.now();
if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));

const outcome = await receipts.commit({
  scorecardId,
  caseId,
  trial,
  childRunId,
  executionId: `evd-${scorecardId}-${caseId}${trial > 0 ? `-t${trial}` : ""}`,
  generation: 1,
  attemptId: `evd-${scorecardId}-${caseId}${trial > 0 ? `-t${trial}` : ""}#g1`,
  resultDigest: `sha256:${childRunId}`,
  committedAt: new Date().toISOString(),
});
console.log(JSON.stringify({ childRunId, won: outcome.kind === "committed", owner: outcome.receipt.childRunId }));
await pool.end();
