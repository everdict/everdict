import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRUST_PG_ENABLED, type TrustPg, openTrustPg, trustId } from "./trust-context.js";

// Trust suite (docs/trust-certification.md) — TRUST-169.
//
// TWO PROCESSES, ONE CASE, ONE RECEIPT — the commit point proved where it actually lives.
//
// TRUST-166 certifies the receipt's semantics in one process, which is a statement about this repository's
// code. The claim it makes is about POSTGRES: that two independent connections racing to commit the same
// (scorecard, case, trial) produce exactly one winner, and that the loser is TOLD whose it is rather than
// left to re-read (which would be racing again).
//
// A single-process test cannot make that claim — its "race" is an interleaving our own event loop decided.
// So this spawns two OS processes that connect separately and wake on the same wall-clock instant. Which one
// wins is not the assertion; that exactly one does, that both name the same owner, and that the table holds
// one row, is.
//
// This is also the shape the system is actually in: an at-least-once Temporal activity re-running a case, a
// recovery adopting a result while the original driver settles, a speculative duplicate finishing first.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const CHILD = path.join(ROOT, "scripts/trust/receipt-race-child.mjs");
const DIST = path.join(ROOT, "packages/db/dist/index.js");

describe.skipIf(!TRUST_PG_ENABLED)("TRUST-169 — two processes committing one case, decided by the database", () => {
  let pg: TrustPg;
  beforeAll(async () => {
    pg = await openTrustPg();
  });
  afterAll(async () => pg?.close());

  function claim(
    scorecardId: string,
    caseId: string,
    childRunId: string,
    startAt: number,
    trial = 0,
  ): Promise<{ childRunId: string; won: boolean; owner: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CHILD, scorecardId, caseId, childRunId, String(trial)], {
        cwd: ROOT,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          DATABASE_URL: process.env.EVERDICT_TRUST_DATABASE_URL ?? "",
          RACE_START_AT: String(startAt),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (c: Buffer) => {
        out += c.toString();
      });
      child.stderr.on("data", (c: Buffer) => {
        err += c.toString();
      });
      child.on("exit", (exit) => {
        if (exit !== 0) return reject(new Error(`receipt child exited ${exit}: ${err}`));
        try {
          resolve(JSON.parse(out.trim()) as { childRunId: string; won: boolean; owner: string });
        } catch {
          reject(new Error(`receipt child printed no verdict: ${out} ${err}`));
        }
      });
    });
  }

  it("the stores are BUILT — this scenario runs the artifact two processes would load", () => {
    expect(existsSync(DIST), `${DIST} is missing — run \`pnpm build\` before the trust suite`).toBe(true);
  });

  it("exactly one attempt commits the case, and BOTH learn who owns it", async () => {
    const scorecardId = trustId("sc-receipt-race");
    // Far enough out that both children have connected and are waiting on the same instant, rather than one
    // still opening its pool while the other writes.
    const startAt = Date.now() + 1_500;
    const [a, b] = await Promise.all([
      claim(scorecardId, "c1", "child-A", startAt),
      claim(scorecardId, "c1", "child-B", startAt),
    ]);

    expect([a, b].filter((r) => r.won)).toHaveLength(1);
    const winner = a.won ? a.childRunId : b.childRunId;
    // The loser is not merely refused — it is told whose the case is, from the same statement that refused
    // it. Anything else sends it back for a second read, which is the race again with extra steps.
    expect(a.owner).toBe(winner);
    expect(b.owner).toBe(winner);

    const { rows } = await pg.client.query<{ child_run_id: string; attempt_id: string | null }>(
      "SELECT child_run_id, attempt_id FROM everdict_case_commit_receipts WHERE scorecard_id = $1 AND case_id = $2",
      [scorecardId, "c1"],
    );
    // One row: the constraint decided, not a comparison made afterwards over rows that are all equally real.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.child_run_id).toBe(winner);
    // …and it names the physical attempt, in the spelling the sealed replay and the artifact key use.
    expect(rows[0]?.attempt_id).toBe(`evd-${scorecardId}-c1#g1`);
  }, 60_000);

  it("a trialled case is claimed once PER TRIAL — N trials are N cases, across processes too", async () => {
    const scorecardId = trustId("sc-receipt-trials");
    const startAt = Date.now() + 1_500;
    // Same case id, DIFFERENT trials, racing from two processes: both must commit. A constraint that keyed
    // on (scorecard, case) alone would let the second trial's evidence be refused as a duplicate of the
    // first — one case's answer standing in for another's, which is worse than either being lost.
    const [t0, t1] = await Promise.all([
      claim(scorecardId, "c1", "child-t0", startAt, 0),
      claim(scorecardId, "c1", "child-t1", startAt, 1),
    ]);
    expect(t0.won).toBe(true);
    expect(t1.won).toBe(true);
    const { rows } = await pg.client.query<{ trial: number; child_run_id: string }>(
      "SELECT trial, child_run_id FROM everdict_case_commit_receipts WHERE scorecard_id = $1 ORDER BY trial",
      [scorecardId],
    );
    expect(rows.map((r) => [Number(r.trial), r.child_run_id])).toEqual([
      [0, "child-t0"],
      [1, "child-t1"],
    ]);
  }, 60_000);
});
