import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PgRunStore } from "@everdict/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRUST_PG_ENABLED, type TrustPg, openTrustPg, trustId } from "./trust-context.js";

// Trust suite (docs/trust-certification.md) — TRUST-135.
//
// FIRST TERMINAL WRITE WINS — proved as a RACE, not as a sequence.
//
// `settleChild` carried that sentence in a comment and implemented read-check-write: read the child, ask the
// domain whether it is already terminal, write. Between the read and the write sits the whole hazard, and the
// competing writer is not a coroutine — it is another process. A user cancels a batch (the control plane
// settles the child `failed{CANCELLED}`) while a case that was already past the point of no return drains
// from a worker and settles it `succeeded`. Both read a running row; both write; the LAST one wins, which is
// the exact inverse of the rule the method is named after. The ledger then says a cancelled batch's child
// succeeded, and every aggregate over that batch counts a result the user stopped.
//
// Two OS processes, two connections, one wall-clock instant. WHICH side wins is not the claim — that exactly
// one does, and that the row and the loser's return value agree about it, is. A scenario asserting a
// particular winner would be asserting the scheduler.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const CHILD = path.join(ROOT, "scripts/trust/settle-race-child.mjs");
const DIST = path.join(ROOT, "packages/db/dist/index.js");

describe.skipIf(!TRUST_PG_ENABLED)("TRUST-135 — a cancel racing a completion settles exactly once", () => {
  let pg: TrustPg;
  beforeAll(async () => {
    pg = await openTrustPg();
  });
  afterAll(async () => pg?.close());

  async function seedRunning(id: string): Promise<void> {
    await pg.client.query(
      `INSERT INTO everdict_runs (id, tenant, harness_id, harness_version, case_id, status, created_at, updated_at)
       VALUES ($1,'trust','h','1.0.0','c-1','running', now(), now())`,
      [id],
    );
  }

  function settle(runId: string, status: string, code: string, startAt: number): Promise<{ won: boolean }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CHILD, runId, status, code], {
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
        if (exit !== 0) return reject(new Error(`settle child exited ${exit}: ${err}`));
        try {
          resolve(JSON.parse(out.trim()) as { won: boolean });
        } catch {
          reject(new Error(`settle child printed no verdict: ${out} ${err}`));
        }
      });
    });
  }

  it("the stores are BUILT — this scenario runs the artifact two processes would load", () => {
    expect(existsSync(DIST), `${DIST} is missing — run \`pnpm build\` before the trust suite`).toBe(true);
  });

  it("two processes settling one run: exactly one commits, and the row agrees with it", async () => {
    const runId = trustId("run-race");
    await seedRunning(runId);
    // Far enough out that both children have connected and are waiting on the same instant, rather than one
    // still opening its pool while the other writes.
    const startAt = Date.now() + 1_500;
    const [cancelled, succeeded] = await Promise.all([
      settle(runId, "failed", "CANCELLED", startAt),
      settle(runId, "succeeded", "", startAt),
    ]);
    const winners = [cancelled, succeeded].filter((r) => r.won);
    expect(winners).toHaveLength(1);

    const { rows } = await pg.client.query<{ status: string; error: { code?: string } | null }>(
      "SELECT status, error FROM everdict_runs WHERE id = $1",
      [runId],
    );
    const row = rows[0];
    // The persisted outcome is the WINNER's, not the last writer's — the loser was refused by the database,
    // not merely overwritten in a way nobody could detect afterwards.
    expect(row?.status).toBe(cancelled.won ? "failed" : "succeeded");
    if (cancelled.won) expect(row?.error?.code).toBe("CANCELLED");
    else expect(row?.error).toBeNull();
  }, 60_000);

  // arch-review 25 P1: STATUS FENCED IS NOT PAYLOAD FENCED. The status race above is only half the
  // settlement — the batch's write-back reflects each case's final result onto its child afterwards, and it
  // did so unconditionally. A case already past the point of no return when the user stopped the batch still
  // came back, and its successful CaseResult landed on a row whose status says CANCELLED: one record making
  // two incompatible claims, with every aggregate over the batch counting the optimistic one.
  it("a cancelled child refuses a late RESULT, not just a late status", async () => {
    const runId = trustId("run-payload");
    await seedRunning(runId);
    const runs = new PgRunStore(pg.client);
    // The user's cancel settles the child…
    await runs.update(
      runId,
      { status: "failed", error: { code: "CANCELLED", message: "stopped" }, updatedAt: new Date().toISOString() },
      undefined,
      { expectNonTerminal: true },
    );
    // …and the case that was already in flight comes back with a real, successful result.
    const late = await runs.update(
      runId,
      {
        result: {
          caseId: "c-1",
          harness: "h@1",
          trace: [],
          scores: [],
          snapshot: { kind: "prompt", output: "done" },
        } as never,
      },
      undefined,
      { expectNotCancelled: true },
    );
    expect(late).toBeUndefined();
    const { rows } = await pg.client.query<{ status: string; result: unknown }>(
      "SELECT status, result FROM everdict_runs WHERE id = $1",
      [runId],
    );
    expect(rows[0]?.status).toBe("failed");
    // No payload at all — the row says one thing about what happened, not two.
    expect(rows[0]?.result).toBeNull();
  }, 60_000);

  it("…and a child that ran and FAILED still takes its result — the rule is narrow on purpose", async () => {
    // A case that genuinely failed has a real result the write-back is supposed to reflect. Fencing every
    // terminal row would have thrown that away, which is why the condition names the settlement that
    // ABANDONED the work rather than terminality in general.
    const runId = trustId("run-failed");
    await seedRunning(runId);
    const runs = new PgRunStore(pg.client);
    await runs.update(
      runId,
      { status: "failed", error: { code: "HARNESS_RUN_FAILED", message: "the agent crashed" } },
      undefined,
      { expectNonTerminal: true },
    );
    const written = await runs.update(
      runId,
      {
        result: {
          caseId: "c-1",
          harness: "h@1",
          trace: [],
          scores: [],
          snapshot: { kind: "prompt", output: "crashed" },
        } as never,
      },
      undefined,
      { expectNotCancelled: true },
    );
    expect(written).toBeDefined();
  }, 60_000);

  it("a writer arriving after the settle is refused — a late drain cannot rewrite a cancelled child", async () => {
    // The sequential half of the same rule, and the one an operator actually sees: the cancel lands, then a
    // dispatch that was already in flight comes back with a result minutes later.
    const runId = trustId("run-late");
    await seedRunning(runId);
    const now = Date.now();
    expect((await settle(runId, "failed", "CANCELLED", now)).won).toBe(true);
    expect((await settle(runId, "succeeded", "", now)).won).toBe(false);
    const { rows } = await pg.client.query<{ status: string; error: { code?: string } | null }>(
      "SELECT status, error FROM everdict_runs WHERE id = $1",
      [runId],
    );
    expect(rows[0]).toMatchObject({ status: "failed" });
    expect(rows[0]?.error?.code).toBe("CANCELLED");
  }, 60_000);
});
