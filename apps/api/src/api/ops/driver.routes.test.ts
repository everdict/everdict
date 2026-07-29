import { RunService, ScorecardService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import { InMemoryRunStore, InMemoryScorecardStore } from "@everdict/db";
import { InMemoryDatasetRegistry } from "@everdict/registry";
import { describe, expect, it } from "vitest";
import type { DriverOpsService } from "../../core/ops/driver-ops-service.js";
import { buildServer } from "../../server.js";

const H = { "x-everdict-tenant": "acme" };

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused in driver-ops tests");
  },
};

// A stub driver-ops seam — the real one is a thin @temporalio/client wrap (covered live); routes own the
// ledger-ownership scoping, role gates and family validation, which is what these tests pin.
function stubOps(calls: string[]): DriverOpsService {
  return {
    workflowIdFor: (family: string, id: string) => `everdict-${family}-${id}`,
    describe: async (family: string, id: string) => {
      calls.push(`describe:${family}:${id}`);
      return {
        family,
        ledgerId: id,
        workflowId: `everdict-${family}-${id}`,
        runId: "run-1",
        status: "RUNNING",
        historyLength: 42,
        pendingActivities: [{ activityType: "scoreGroupCase", attempt: 3, lastFailure: "CP unreachable" }],
      };
    },
    cancel: async (family: string, id: string) => {
      calls.push(`cancel:${family}:${id}`);
    },
  } as unknown as DriverOpsService;
}

async function build(withOps = true) {
  const store = new InMemoryScorecardStore();
  await store.create({
    id: "sc-1",
    tenant: "acme",
    dataset: { id: "d", version: "1" },
    harness: { id: "h", version: "1" },
    status: "running",
    createdAt: "2026-07-30T00:00:00Z",
    updatedAt: "2026-07-30T00:00:00Z",
  });
  const calls: string[] = [];
  const app = buildServer({
    service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    scorecardService: new ScorecardService({
      dispatcher: unusedDispatcher,
      store,
      datasets: new InMemoryDatasetRegistry(),
    }),
    ...(withOps ? { driverOps: stubOps(calls) } : {}),
  });
  return { app, calls };
}

describe("Driver ops surface v0 (/ops/driver — ledger-vocabulary addressing)", () => {
  it("describes a workflow by ledger id — status, history pressure, pending activities with last failure", async () => {
    const { app, calls } = await build();
    const res = await app.inject({ method: "GET", url: "/ops/driver/batch/sc-1", headers: H });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.workflowId).toBe("everdict-batch-sc-1");
    expect(body.status).toBe("RUNNING");
    expect(body.pendingActivities[0]).toMatchObject({ attempt: 3, lastFailure: "CP unreachable" });
    expect(calls).toEqual(["describe:batch:sc-1"]);
  });

  it("cancels through the wrap (score family) and never exposes a raw workflowId address", async () => {
    const { app, calls } = await build();
    const res = await app.inject({ method: "POST", url: "/ops/driver/score/sc-1/cancel", headers: H });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(calls).toEqual(["cancel:score:sc-1"]);
  });

  it("scopes by LEDGER ownership — another workspace's id reads 404 before Temporal is ever asked", async () => {
    const { app, calls } = await build();
    const res = await app.inject({
      method: "GET",
      url: "/ops/driver/batch/sc-1",
      headers: { "x-everdict-tenant": "rival" },
    });
    expect(res.statusCode).toBe(404);
    expect(calls).toEqual([]); // the guard fires first — no cross-tenant describe
  });

  it("rejects an unknown family (400) and answers 404 'not configured' without a Temporal address", async () => {
    const { app } = await build();
    expect((await app.inject({ method: "GET", url: "/ops/driver/nope/sc-1", headers: H })).statusCode).toBe(400);
    const { app: bare } = await build(false);
    const res = await bare.inject({ method: "GET", url: "/ops/driver/batch/sc-1", headers: H });
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toMatch(/not configured/);
  });
});
