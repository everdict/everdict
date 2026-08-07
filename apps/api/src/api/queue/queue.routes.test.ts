import { QueueService, RunService, type SchedulerQueueEntryView } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import { InMemoryRunStore, InMemoryScorecardStore } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../server.js";

const H = { "x-everdict-tenant": "acme" };

// The queue transport over a QueueService with a FAKE scheduler queue — two waiting entries, one of them another
// tenant's (the tenant guard must make it unaddressable through the workspace-scoped surface).
function build() {
  const cancelled: string[] = [];
  const promoted: string[] = [];
  const entries: SchedulerQueueEntryView[] = [
    {
      id: "q1",
      tenant: "acme",
      caseId: "mine",
      batchId: "sc1",
      harness: { id: "h", version: "1" },
      tags: ["judge"],
      enqueuedAt: Date.parse("2026-07-03T11:59:00.000Z"),
      urgent: false,
      promoted: false,
    },
    {
      id: "q2",
      tenant: "beta",
      caseId: "theirs",
      harness: { id: "h", version: "1" },
      enqueuedAt: Date.parse("2026-07-03T11:59:00.000Z"),
      urgent: false,
      promoted: false,
    },
  ];
  const queueService = new QueueService({
    scorecards: new InMemoryScorecardStore(),
    runs: new InMemoryRunStore(),
    schedulerStats: () => ({
      queued: 2,
      inFlight: {},
      memInFlightMb: {},
      tenantInFlight: { acme: 0 },
      queuedByTenant: { acme: 1 },
    }),
    schedulerQueue: () => entries,
    cancelSchedulerEntry: (id) => {
      cancelled.push(id);
      return true;
    },
    promoteSchedulerEntry: (id) => {
      promoted.push(id);
      return true;
    },
    now: () => "2026-07-03T12:00:00.000Z",
  });
  // ServerDeps requires the run service; a never-dispatching fake satisfies it (no run route is exercised here).
  const noDispatch: Dispatcher = {
    dispatch() {
      return Promise.reject(new Error("not under test"));
    },
  };
  const app = buildServer({
    service: new RunService({ dispatcher: noDispatch, store: new InMemoryRunStore() }),
    queueService,
  });
  return { app, cancelled, promoted };
}

describe("queue entry controls (/queue/entries — the real scheduler queue)", () => {
  it("GET /queue surfaces this workspace's scheduler entries in scan order (another tenant's never appear)", async () => {
    const { app } = build();
    const res = await app.inject({ method: "GET", url: "/queue", headers: H });
    expect(res.statusCode).toBe(200);
    const entries = res.json().scheduler.entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: "q1", caseId: "mine", position: 1, tags: ["judge"], waitedMs: 60_000 });
    expect(JSON.stringify(res.json())).not.toContain("theirs");
  });

  it("DELETE /queue/entries/:id cancels an owned waiting entry; POST …/promote moves it to the front", async () => {
    const { app, cancelled, promoted } = build();
    const del = await app.inject({ method: "DELETE", url: "/queue/entries/q1", headers: H });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ cancelled: true });
    expect(cancelled).toEqual(["q1"]);

    const pro = await app.inject({ method: "POST", url: "/queue/entries/q1/promote", headers: H });
    expect(pro.statusCode).toBe(200);
    expect(pro.json()).toEqual({ promoted: true });
    expect(promoted).toEqual(["q1"]);
  });

  it("another workspace's entry — and an unknown id — read 404 with no existence leak", async () => {
    const { app, cancelled } = build();
    for (const url of ["/queue/entries/q2", "/queue/entries/ghost"]) {
      const del = await app.inject({ method: "DELETE", url, headers: H });
      expect(del.statusCode).toBe(404);
      const pro = await app.inject({ method: "POST", url: `${url}/promote`, headers: H });
      expect(pro.statusCode).toBe(404);
    }
    expect(cancelled).toEqual([]); // the guard rejected before the scheduler was touched
  });
});
