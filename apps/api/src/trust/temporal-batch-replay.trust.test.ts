import { type ChildProcess, spawn } from "node:child_process";
import { type Server, createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Connection } from "@temporalio/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRUST_PG_ENABLED, trustId } from "./trust-context.js";

// Trust suite (docs/trust-certification.md) — TRUST-143.
//
// THE SEAM PRODUCTION ACTUALLY DRIVES.
//
// TRUST-140 kills a worker running `evalCaseWorkflow`, which certifies the durability PRIMITIVE. It is not
// the path a scorecard takes: a batch runs `scorecardBatchWorkflow` → `runBatchCase` → an HTTP request that
// stays open while the control plane executes one whole eval case. That activity had the same one-hour
// start-to-close and no heartbeat as the primitive did, was fixed in the same review, and was certified by
// the scenario for the OTHER path — "we fixed both, and tested one" is how a seam keeps its old latency
// while the page says otherwise.
//
// So this drives the real workflow module and the real activity factory: the same bridge, the same heartbeat
// wrapper, the same retry policy an operator's worker runs. The far side of the bridge is the scenario's,
// because a control plane that hangs on demand is exactly what a certification needs and production cannot
// offer — and each worker gets its own URL PREFIX, so the ledger can say which one made every call.
//
// What is asserted is the whole chain: worker A is SIGKILLed mid-case, worker B re-runs that case, and the
// batch finalizes EXACTLY ONCE. A batch that finalized twice would settle a scorecard twice.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const WORKER = path.join(ROOT, "scripts/trust/temporal-batch-worker.mjs");
const ADDRESS = process.env.EVERDICT_TRUST_TEMPORAL ?? "localhost:7233";
const TOKEN = "trust-batch-internal";

describe.skipIf(!TRUST_PG_ENABLED)(
  "TRUST-143 — a killed batch worker's case is re-run and the batch finalizes once",
  () => {
    let client: Client | undefined;
    let connection: Connection | undefined;
    let bridge: Server | undefined;
    let port = 0;
    const spawned: ChildProcess[] = [];
    // Every call the workers made, in order: which worker (from its URL prefix) did what.
    const calls: Array<{ worker: string; op: string; caseId?: string }> = [];
    let holdFirstCase = true;

    beforeAll(async () => {
      try {
        connection = await Connection.connect({ address: ADDRESS, connectTimeout: 3_000 });
        client = new Client({ connection });
      } catch {
        connection = undefined;
      }
      // The control plane's side of the internal bridge. Deliberately minimal: what is under test is the
      // workflow, the activity and the worker lifecycle, not the control plane's own batch logic (TRUST-127
      // boots the real one for the claims that are about it).
      bridge = createServer((req, res) => {
        const url = req.url ?? "";
        const worker = url.startsWith("/wA") ? "worker-A" : "worker-B";
        const reply = (body: unknown): void => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        };
        if (req.headers["x-internal-token"] !== TOKEN) {
          res.writeHead(401);
          res.end();
          return;
        }
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          if (url.includes("/plan")) {
            calls.push({ worker, op: "plan" });
            reply({ caseIds: ["case-1"], concurrency: 1 });
            return;
          }
          if (url.includes("/finalize")) {
            calls.push({ worker, op: "finalize" });
            reply({});
            return;
          }
          const caseId = (JSON.parse(body || "{}") as { caseId?: string }).caseId;
          calls.push({ worker, op: "case", ...(caseId ? { caseId } : {}) });
          // The first attempt never answers: the worker holding it open is the one about to be killed, which
          // is the state the whole durability claim is about.
          if (holdFirstCase) {
            holdFirstCase = false;
            return; // response deliberately left open
          }
          reply({ settled: true });
        });
      });
      await new Promise<void>((resolve) => {
        bridge?.listen(0, "127.0.0.1", () => {
          const address = bridge?.address();
          port = typeof address === "object" && address !== null ? address.port : 0;
          resolve();
        });
      });
    }, 30_000);

    afterAll(async () => {
      for (const child of spawned) child.kill("SIGKILL");
      await new Promise<void>((resolve) => (bridge ? bridge.close(() => resolve()) : resolve()));
      await connection?.close();
    });

    function startWorker(taskQueue: string, id: "wA" | "wB"): ChildProcess {
      const child = spawn(process.execPath, [WORKER], {
        cwd: ROOT,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          TEMPORAL_ADDRESS: ADDRESS,
          TRUST_TASK_QUEUE: taskQueue,
          // The prefix IS the worker's identity on the wire — the activity appends `/internal/batches/…` to it.
          EVERDICT_API_URL: `http://127.0.0.1:${port}/${id}`,
          EVERDICT_INTERNAL_TOKEN: TOKEN,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      spawned.push(child);
      return child;
    }

    const until = async (predicate: () => boolean, ms: number, what: string): Promise<void> => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error(`timed out waiting for ${what}`);
    };

    it("worker A is killed mid-case, worker B re-runs it, and the batch finalizes exactly once", async () => {
      if (!client)
        throw new Error(
          `TRUST-143 cannot run: no Temporal at ${ADDRESS}. Start one (\`temporal server start-dev\`) or set EVERDICT_TRUST_TEMPORAL.`,
        );
      const taskQueue = trustId("tq-batch");
      startWorker(taskQueue, "wA");
      const handle = await client.workflow.start("scorecardBatchWorkflow", {
        taskQueue,
        workflowId: trustId("wf-batch"),
        args: [{ scorecardId: trustId("sc") }],
      });

      // …the case request is open on worker A when the kill lands. Waiting for the CALL rather than a sleep is
      // what makes this about behaviour instead of about machine speed.
      await until(() => calls.some((c) => c.worker === "worker-A" && c.op === "case"), 60_000, "worker A's case call");
      spawned[spawned.length - 1]?.kill("SIGKILL");

      // No cooperative shutdown ran. The batch now exists only in Temporal's history — and the heartbeat is
      // what lets the server notice within the minute rather than at the one-hour start-to-close.
      startWorker(taskQueue, "wB");
      await handle.result();

      const cases = calls.filter((c) => c.op === "case");
      const finalizes = calls.filter((c) => c.op === "finalize");
      // The case was attempted by the dead worker and RE-RUN by its replacement — the work was not lost.
      expect(cases.map((c) => c.worker)).toContain("worker-A");
      expect(cases.map((c) => c.worker)).toContain("worker-B");
      // …and the batch settled ONCE. A finalize per attempt would settle a scorecard twice, which is the shape
      // at-least-once activity delivery would produce if the workflow's own structure did not prevent it.
      expect(finalizes).toHaveLength(1);
      expect(finalizes[0]?.worker).toBe("worker-B");
    }, 240_000);
  },
);
