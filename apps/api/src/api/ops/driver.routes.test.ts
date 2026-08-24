import { RunService, ScorecardService, SubscriptionService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import { InMemoryRunStore, InMemoryScorecardStore, InMemorySubscriptionStore } from "@everdict/db";
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
    terminate: async (family: string, id: string) => {
      calls.push(`terminate:${family}:${id}`);
    },
    terminateRaw: async (workflowId: string) => {
      calls.push(`terminateRaw:${workflowId}`);
    },
    list: async () => {
      calls.push("list");
      return [];
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

  it("force-terminates through the wrap with the same ownership scoping as cancel", async () => {
    const { app, calls } = await build();
    const ok = await app.inject({ method: "POST", url: "/ops/driver/batch/sc-1/terminate", headers: H });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true });
    expect(calls).toEqual(["terminate:batch:sc-1"]);

    const rival = await app.inject({
      method: "POST",
      url: "/ops/driver/batch/sc-1/terminate",
      headers: { "x-everdict-tenant": "rival" },
    });
    expect(rival.statusCode).toBe(404); // guard first — no cross-tenant terminate
    expect(calls).toEqual(["terminate:batch:sc-1"]);
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

describe("operator surface (/internal/driver) — the fleet-wide workflow inventory + zombie killer", () => {
  function buildInternal() {
    const calls: string[] = [];
    const app = buildServer({
      service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
      driverOps: stubOps(calls),
      internalToken: "sekrit",
    });
    return { app, calls };
  }

  it("is fail-closed behind the internal token (never end-user auth)", async () => {
    const { app } = buildInternal();
    expect((await app.inject({ method: "GET", url: "/internal/driver/workflows", headers: H })).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/internal/driver/workflows/terminate",
          headers: H,
          payload: { workflowId: "everdict-reaper-x" },
        })
      ).statusCode,
    ).toBe(403);
  });

  it("lists the everdict workflow inventory and terminates by RAW workflowId (the leaked-workflow path)", async () => {
    const { app, calls } = buildInternal();
    const list = await app.inject({
      method: "GET",
      url: "/internal/driver/workflows?status=running",
      headers: { "x-internal-token": "sekrit" },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ workflows: [] });

    const terminate = await app.inject({
      method: "POST",
      url: "/internal/driver/workflows/terminate",
      headers: { "x-internal-token": "sekrit" },
      payload: { workflowId: "everdict-reaper-ghost", reason: "orphaned reaper" },
    });
    expect(terminate.statusCode).toBe(200);
    expect(terminate.json()).toEqual({ ok: true });
    expect(calls).toEqual(["list", "terminateRaw:everdict-reaper-ghost"]);
  });
});

describe("reaction family ownership (fix: the guard knew every family but reaction)", () => {
  it("describes a reaction chain by <eventId>-<subscriptionId> when the rule is the tenant's — another tenant reads 404", async () => {
    const { calls } = await build();
    const subscriptionService = new SubscriptionService({ store: new InMemorySubscriptionStore() });
    const rule = await subscriptionService.create({
      tenant: "acme",
      createdBy: "member",
      name: "chain",
      selector: { kinds: ["dataset.registered"], filters: [] },
      reaction: { kind: "workflow", steps: [{ agentId: "triage" }] },
    });
    // Rebuild with the subscription service present (the guard resolves the rule id from the ledger id's tail).
    const withSubs = buildServer({
      service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
      subscriptionService,
      driverOps: stubOps(calls),
    });
    const eventId = "11111111-2222-3333-4444-555555555555";
    const ok = await withSubs.inject({ method: "GET", url: `/ops/driver/reaction/${eventId}-${rule.id}`, headers: H });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().workflowId).toBe(`everdict-reaction-${eventId}-${rule.id}`);

    const rival = await withSubs.inject({
      method: "GET",
      url: `/ops/driver/reaction/${eventId}-${rule.id}`,
      headers: { "x-everdict-tenant": "rival" },
    });
    expect(rival.statusCode).toBe(404); // the rule is acme's — no existence leak
  });
});
