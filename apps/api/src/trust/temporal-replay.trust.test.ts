import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Connection } from "@temporalio/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRUST_PG_ENABLED, type TrustPg, openTrustPg, trustId } from "./trust-context.js";

// Trust suite (docs/trust-certification.md) — TRUST-140.
//
// THE LAST TIER-B ITEM: a Temporal worker killed mid-activity, and a replacement that finishes the work.
//
// Everything this platform builds on durable execution rests on one property — a workflow survives the
// process running it. That property has been asserted in design documents and exercised by hand
// (`scripts/live/orchestration-torture.mjs`), and never certified, because certifying it needs a real
// Temporal service rather than a fake that always replays correctly.
//
// So this runs the REAL workflow module (the built one an operator ships), against a REAL Temporal, with two
// real worker processes. Worker A is killed with SIGKILL while its activity is in flight — no shutdown hook,
// no cooperative drain, the way a machine dies. Worker B is then started, and the assertion is that the
// workflow COMPLETES and its result is worker B's.
//
// The activity ledger is what makes the claim honest rather than optimistic: Temporal's contract is
// at-least-once execution of an activity, so the ledger may hold two rows. What must be exactly one is the
// workflow's RESULT — the thing everything downstream treats as the case's outcome.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const WORKER = path.join(ROOT, "scripts/trust/temporal-worker.mjs");
const WORKFLOWS = path.join(ROOT, "packages/orchestrator/dist/workflows.js");
const ADDRESS = process.env.EVERDICT_TRUST_TEMPORAL ?? "localhost:7233";

// Is there a Temporal to certify against? A missing one FAILS this scenario rather than passing quietly —
// see the throw below for why the obvious early-return was the more dangerous of the two.
const temporalReachable = async (): Promise<boolean> => {
  try {
    const connection = await Connection.connect({ address: ADDRESS, connectTimeout: 3_000 });
    await connection.close();
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(!TRUST_PG_ENABLED)("TRUST-140 — a killed Temporal worker loses no work and produces one result", () => {
  let pg: TrustPg;
  let client: Client | undefined;
  let connection: Connection | undefined;
  const spawned: ChildProcess[] = [];

  beforeAll(async () => {
    pg = await openTrustPg();
    // The effects ledger this scenario reads. Created here rather than as a migration: it is scaffolding for
    // one certification, not a table the product owns.
    await pg.client.query(
      `CREATE TABLE IF NOT EXISTS everdict_trust_temporal_effects (
         task_queue text NOT NULL, worker_id text NOT NULL, case_id text NOT NULL, at timestamptz NOT NULL)`,
    );
    if (await temporalReachable()) {
      connection = await Connection.connect({ address: ADDRESS });
      client = new Client({ connection });
    }
  }, 30_000);

  afterAll(async () => {
    for (const child of spawned) child.kill("SIGKILL");
    await connection?.close();
    await pg?.close();
  });

  function startWorker(taskQueue: string, id: string, holdMs: number): ChildProcess {
    const child = spawn(process.execPath, [WORKER], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        DATABASE_URL: process.env.EVERDICT_TRUST_DATABASE_URL ?? "",
        TEMPORAL_ADDRESS: ADDRESS,
        TRUST_TASK_QUEUE: taskQueue,
        TRUST_WORKER_ID: id,
        TRUST_ACTIVITY_HOLD_MS: String(holdMs),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    spawned.push(child);
    return child;
  }

  const effects = async (taskQueue: string): Promise<Array<{ worker_id: string }>> =>
    (
      await pg.client.query<{ worker_id: string }>(
        "SELECT worker_id FROM everdict_trust_temporal_effects WHERE task_queue = $1 ORDER BY at",
        [taskQueue],
      )
    ).rows;

  const until = async (predicate: () => Promise<boolean>, ms: number, what: string): Promise<void> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  it("the workflow module is BUILT — this scenario runs the artifact, not the source", () => {
    expect(existsSync(WORKFLOWS), `${WORKFLOWS} is missing — run \`pnpm build\` before the trust suite`).toBe(true);
  });

  it("a SIGKILLed worker is replaced, the workflow completes, and the result is exactly one", async () => {
    // A PRINTED "SKIPPED" IS NOT A SKIP (arch-review 27 P0). The first version of this returned early with a
    // console warning when Temporal was unreachable — and vitest reports a test that returns as PASSED, so
    // the runner counted it, `skipped: 0` held, and the certification could print PASS over a durability
    // claim nothing had exercised. That is precisely the false green this suite's own rule exists to stop,
    // arrived at through the one door the rule does not watch: the reporter's status field.
    //
    // So it FAILS instead. An operator running one scenario on a laptop gets the same treatment Postgres
    // gives them — the whole file is skipped by `TRUST_PG_ENABLED` when the suite is not enabled at all.
    if (!client)
      throw new Error(
        `TRUST-140 cannot run: no Temporal at ${ADDRESS}. Start one (\`temporal server start-dev\`) or set EVERDICT_TRUST_TEMPORAL. A durability claim nobody exercised is not a certified one.`,
      );
    const taskQueue = trustId("tq");
    const caseId = trustId("case");

    // Worker A holds its activity for 60s — long enough that the kill lands mid-flight.
    startWorker(taskQueue, "worker-A", 60_000);
    const handle = await client.workflow.start("evalCaseWorkflow", {
      taskQueue,
      workflowId: trustId("wf"),
      args: [{ evalCase: { id: caseId }, harness: { id: "trust", version: "1" } }],
    });

    // …the activity is running when we kill it. Waiting for the LEDGER rather than for a fixed sleep is what
    // makes this a scenario about behaviour instead of about machine speed.
    await until(async () => (await effects(taskQueue)).length >= 1, 60_000, "worker A to start the activity");
    spawned[spawned.length - 1]?.kill("SIGKILL");

    // No cooperative shutdown ran. The work now exists only in Temporal's history.
    startWorker(taskQueue, "worker-B", 0);

    const result = (await handle.result()) as { snapshot?: { output?: string } };
    // ONE result, and it is the replacement's — the workflow did not lose the case and did not return the
    // dead worker's half-finished state.
    expect(result.snapshot?.output).toBe("settled by worker-B");

    const rows = await effects(taskQueue);
    // At-least-once is Temporal's honest contract, so the ledger may hold both attempts. What must be true is
    // that the second one ran on the replacement — the killed worker's attempt was retried, not abandoned.
    expect(rows.map((r) => r.worker_id)).toContain("worker-B");
    expect(rows.length).toBeGreaterThanOrEqual(1);
  }, 180_000);
});
