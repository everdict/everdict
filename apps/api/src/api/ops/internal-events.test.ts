import { PlatformEventService, RunService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import { InMemoryPlatformEventStore, InMemoryRunStore } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../server.js";

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused in event tests");
  },
};
const svc = () => new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() });

function harness() {
  const store = new InMemoryPlatformEventStore();
  const platformEvents = new PlatformEventService({ store, newId: () => `ev-${++harness.seq}` });
  const app = buildServer({ service: svc(), platformEvents, internalToken: "itok" });
  return { app, platformEvents };
}
harness.seq = 0;

// The internal reconcile cursor (agent-automation A1): the agent service walks `seq > after` per workspace.
describe("GET /internal/events — platform-event reconcile cursor", () => {
  it("returns a workspace's events ascending from the cursor, kind-filterable", async () => {
    const { app, platformEvents } = harness();
    await platformEvents.emit({
      workspace: "acme",
      kind: "scorecard.submitted",
      subject: { type: "scorecard", id: "sc-1" },
      message: "submitted",
    });
    await platformEvents.emit({
      workspace: "acme",
      kind: "scorecard.completed",
      subject: { type: "scorecard", id: "sc-1" },
      message: "completed",
    });
    await platformEvents.emit({
      workspace: "other",
      kind: "scorecard.completed",
      subject: { type: "scorecard", id: "sc-9" },
      message: "other workspace",
    });

    const all = await app.inject({
      method: "GET",
      url: "/internal/events?workspace=acme",
      headers: { "x-internal-token": "itok" },
    });
    expect(all.statusCode).toBe(200);
    const events = (all.json() as { events: Array<{ kind: string; seq: number }> }).events;
    expect(events.map((e) => e.kind)).toEqual(["scorecard.submitted", "scorecard.completed"]);

    const after = await app.inject({
      method: "GET",
      url: `/internal/events?workspace=acme&after=${events[0]?.seq}&kinds=scorecard.completed`,
      headers: { "x-internal-token": "itok" },
    });
    const later = (after.json() as { events: Array<{ kind: string; seq: number }> }).events;
    expect(later).toHaveLength(1);
    expect(later[0]?.kind).toBe("scorecard.completed");
    await app.close();
  });

  it("rejects a wrong internal token (403); no workspace = the deployment-wide cursor", async () => {
    const { app, platformEvents } = harness();
    await platformEvents.emit({
      workspace: "acme",
      kind: "run.completed",
      subject: { type: "run", id: "r-1" },
      message: "acme run",
    });
    await platformEvents.emit({
      workspace: "other",
      kind: "run.completed",
      subject: { type: "run", id: "r-2" },
      message: "other run",
    });
    const wrong = await app.inject({
      method: "GET",
      url: "/internal/events?workspace=acme",
      headers: { "x-internal-token": "nope" },
    });
    expect(wrong.statusCode).toBe(403);
    const global = await app.inject({
      method: "GET",
      url: "/internal/events",
      headers: { "x-internal-token": "itok" },
    });
    expect(global.statusCode).toBe(200);
    const tenants = (global.json() as { events: Array<{ tenant: string }> }).events.map((e) => e.tenant);
    expect(tenants).toEqual(["acme", "other"]);
    await app.close();
  });

  it("serves members the workspace log newest-first (GET /events, events:read)", async () => {
    const { app, platformEvents } = harness();
    await platformEvents.emit({
      workspace: "acme",
      kind: "scorecard.submitted",
      subject: { type: "scorecard", id: "sc-1" },
      message: "submitted",
    });
    await platformEvents.emit({
      workspace: "acme",
      kind: "scorecard.completed",
      subject: { type: "scorecard", id: "sc-1" },
      message: "completed",
    });

    const res = await app.inject({ method: "GET", url: "/events", headers: { "x-everdict-tenant": "acme" } });
    expect(res.statusCode).toBe(200);
    const events = (res.json() as { events: Array<{ kind: string }> }).events;
    expect(events.map((e) => e.kind)).toEqual(["scorecard.completed", "scorecard.submitted"]);
    await app.close();
  });

  it("is fail-closed 404 when no internal token is configured", async () => {
    const store = new InMemoryPlatformEventStore();
    const platformEvents = new PlatformEventService({ store });
    const app = buildServer({ service: svc(), platformEvents });
    const res = await app.inject({ method: "GET", url: "/internal/events?workspace=acme" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

// P3: agent activations enter the universal ledger through the SAME report bridge that carries the
// agent.run.* facts — started opens Run{kind:"agent"}, the terminal report settles it, both idempotent.
describe("POST /internal/agent-run-events — the agent-run ledger bridge (P3)", () => {
  function ledgerHarness() {
    const runStore = new InMemoryRunStore();
    const platformEvents = new PlatformEventService({ store: new InMemoryPlatformEventStore() });
    const app = buildServer({
      service: new RunService({ dispatcher: unusedDispatcher, store: runStore }),
      platformEvents,
      internalToken: "itok",
    });
    return { app, runStore };
  }
  const report = (over: Record<string, unknown>) => ({
    tenant: "acme",
    kind: "agent.run.started",
    sessionId: "sess-1",
    agentId: "sentinel",
    eventKind: "scorecard.completed",
    message: "woke",
    runId: "run-a1",
    agentVersion: "1.0.0",
    eventId: "ev-7",
    creator: "alice",
    ...over,
  });

  it("started opens Run{kind:agent} (running, background, session group, event origin); terminal settles it", async () => {
    const { app, runStore } = ledgerHarness();
    const started = await app.inject({
      method: "POST",
      url: "/internal/agent-run-events",
      headers: { "x-internal-token": "itok" },
      payload: report({}),
    });
    expect(started.statusCode).toBe(200);
    const run = await runStore.get("run-a1");
    expect(run).toMatchObject({
      kind: "agent",
      class: "background",
      lifetime: "task",
      status: "running",
      harness: { id: "sentinel", version: "1.0.0" }, // the executable IS the agent spec
      caseId: "ev-7", // the activation cause
      createdBy: "alice",
      trigger: "agent",
      origin: { cause: "event", eventKind: "scorecard.completed", eventId: "ev-7", actor: "alice" },
      group: { id: "sess-1", role: "turn" },
    });

    // A retried started-report never duplicates or resets the record.
    await app.inject({
      method: "POST",
      url: "/internal/agent-run-events",
      headers: { "x-internal-token": "itok" },
      payload: report({}),
    });
    expect((await runStore.list("acme", { includeChildren: true })).filter((r) => r.id === "run-a1")).toHaveLength(1);

    const done = await app.inject({
      method: "POST",
      url: "/internal/agent-run-events",
      headers: { "x-internal-token": "itok" },
      payload: report({ kind: "agent.run.completed", message: "run completed" }),
    });
    expect(done.statusCode).toBe(200);
    expect((await runStore.get("run-a1"))?.status).toBe("succeeded");

    // First terminal write wins — a late failure report never flips a settled run.
    await app.inject({
      method: "POST",
      url: "/internal/agent-run-events",
      headers: { "x-internal-token": "itok" },
      payload: report({ kind: "agent.run.failed", message: "late" }),
    });
    expect((await runStore.get("run-a1"))?.status).toBe("succeeded");
  });

  it("cancelled maps onto the 4-status lifecycle as failed{CANCELLED}; awaiting_approval never touches the ledger", async () => {
    const { app, runStore } = ledgerHarness();
    await app.inject({
      method: "POST",
      url: "/internal/agent-run-events",
      headers: { "x-internal-token": "itok" },
      payload: report({}),
    });
    await app.inject({
      method: "POST",
      url: "/internal/agent-run-events",
      headers: { "x-internal-token": "itok" },
      payload: report({ kind: "agent.run.awaiting_approval", message: "parked" }),
    });
    expect((await runStore.get("run-a1"))?.status).toBe("running"); // event-only — no transition
    await app.inject({
      method: "POST",
      url: "/internal/agent-run-events",
      headers: { "x-internal-token": "itok" },
      payload: report({ kind: "agent.run.cancelled", message: "stopped by member" }),
    });
    const run = await runStore.get("run-a1");
    expect(run?.status).toBe("failed");
    expect(run?.error).toEqual({ code: "CANCELLED", message: "stopped by member" });
  });

  it("a report WITHOUT runId keeps the event-only behavior (an older agent service)", async () => {
    const { app, runStore } = ledgerHarness();
    const res = await app.inject({
      method: "POST",
      url: "/internal/agent-run-events",
      headers: { "x-internal-token": "itok" },
      payload: {
        tenant: "acme",
        kind: "agent.run.started",
        sessionId: "sess-1",
        agentId: "sentinel",
        eventKind: "scorecard.completed",
        message: "woke",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(await runStore.list("acme", { includeChildren: true })).toEqual([]);
  });
});
