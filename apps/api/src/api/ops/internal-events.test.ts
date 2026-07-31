import { PlatformEventService, RunService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import { PaymentRequiredError } from "@everdict/contracts";
import { InMemoryPlatformEventStore, InMemoryRunStore, InMemoryTrajectoryStore } from "@everdict/db";
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
    const trajectories = new InMemoryTrajectoryStore();
    const platformEvents = new PlatformEventService({ store: new InMemoryPlatformEventStore() });
    const app = buildServer({
      service: new RunService({ dispatcher: unusedDispatcher, store: runStore, trajectories }),
      platformEvents,
      internalToken: "itok",
    });
    return { app, runStore, trajectories };
  }
  const post = {
    method: "POST" as const,
    url: "/internal/agent-run-events",
    headers: { "x-internal-token": "itok" },
  };
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

  it("a terminal report's transcript trace seals as the run's OWN trajectory (O2) — first write wins", async () => {
    const { app, trajectories } = ledgerHarness();
    await app.inject({
      method: "POST",
      url: "/internal/agent-run-events",
      headers: { "x-internal-token": "itok" },
      payload: report({}),
    });
    const trace = [
      { t: 0, kind: "message", role: "user", text: "[scorecard.completed] woke" },
      { t: 1, kind: "tool_call", id: "c1", name: "get_scorecard", args: { id: "sc-1" } },
      { t: 2, kind: "tool_result", id: "c1", ok: true, output: "ok" },
    ];
    const done = await app.inject({
      method: "POST",
      url: "/internal/agent-run-events",
      headers: { "x-internal-token": "itok" },
      payload: report({ kind: "agent.run.completed", message: "run completed", trace }),
    });
    expect(done.statusCode).toBe(200);
    const sealed = await trajectories.get("acme", "run-a1");
    expect(sealed?.meta).toMatchObject({ source: "run", eventCount: 3 });
    expect(sealed?.events).toEqual(trace);

    // An at-least-once retry re-offers harmlessly — the sealed evidence never rewrites.
    await app.inject({
      method: "POST",
      url: "/internal/agent-run-events",
      headers: { "x-internal-token": "itok" },
      payload: report({
        kind: "agent.run.completed",
        message: "late retry",
        trace: [{ t: 0, kind: "message", role: "assistant", text: "rewritten" }],
      }),
    });
    expect((await trajectories.get("acme", "run-a1"))?.events).toHaveLength(3);

    // A malformed trace is a 400 at the boundary — never a silent partial seal.
    const bad = await app.inject({
      method: "POST",
      url: "/internal/agent-run-events",
      headers: { "x-internal-token": "itok" },
      payload: report({ kind: "agent.run.completed", message: "bad", trace: [{ t: 0, kind: "nope" }] }),
    });
    expect(bad.statusCode).toBe(400);
  });

  it("cause=chat opens a MEMBER-caused interactive run, seals its transcript, and stays off the event log (O1)", async () => {
    const runStore = new InMemoryRunStore();
    const trajectories = new InMemoryTrajectoryStore();
    const eventStore = new InMemoryPlatformEventStore();
    const app = buildServer({
      service: new RunService({ dispatcher: unusedDispatcher, store: runStore, trajectories }),
      platformEvents: new PlatformEventService({ store: eventStore }),
      internalToken: "itok",
    });
    const chat = (over: Record<string, unknown>) => ({
      tenant: "acme",
      kind: "agent.run.started",
      sessionId: "sess-chat",
      agentId: "default",
      eventKind: "chat",
      message: "Chat turn in conversation sess-chat.",
      runId: "run-chat-1",
      creator: "alice",
      cause: "chat",
      ...over,
    });

    expect((await app.inject({ ...post, payload: chat({}) })).statusCode).toBe(200);
    expect(await runStore.get("run-chat-1")).toMatchObject({
      kind: "agent",
      class: "interactive", // a member is waiting on it — never scheduled like background fan-out
      status: "running",
      caseId: "chat",
      createdBy: "alice",
      origin: { cause: "member", actor: "alice" },
      group: { id: "sess-chat", role: "turn" }, // the conversation groups its turns
    });

    const trace = [
      { t: 0, kind: "message", role: "user", text: "what changed?" },
      { t: 1, kind: "message", role: "assistant", text: "two runs regressed." },
    ];
    expect(
      (
        await app.inject({
          ...post,
          payload: chat({ kind: "agent.run.completed", message: "Chat turn completed.", trace }),
        })
      ).statusCode,
    ).toBe(200);
    expect((await runStore.get("run-chat-1"))?.status).toBe("succeeded");
    expect((await trajectories.get("acme", "run-chat-1"))?.events).toEqual(trace);

    // Human typing volume must not drown the event log — the conversation is already visible as itself.
    expect(await eventStore.list("acme")).toEqual([]);
  });

  it("cause=chat without a creator is refused (400) — an unattributed turn would be a lie in the ledger", async () => {
    const { app, runStore } = ledgerHarness();
    const res = await app.inject({
      ...post,
      payload: {
        tenant: "acme",
        kind: "agent.run.started",
        sessionId: "sess-chat",
        agentId: "default",
        eventKind: "chat",
        message: "Chat turn.",
        runId: "run-chat-2",
        cause: "chat",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(await runStore.get("run-chat-2")).toBeUndefined();
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

// P5 dual-read: the owned trajectory serves first; the run row's embed answers in the same shape until the
// embeds retire (O10 — no backfill, dual-read is the bridge).
describe("RunService.trajectory — the owned copy with the embed fallback (P5)", () => {
  it("prefers the sealed store copy, falls back to the embed, and scopes by workspace", async () => {
    const store = new InMemoryRunStore();
    const trajectories = new InMemoryTrajectoryStore();
    const service = new RunService({ dispatcher: unusedDispatcher, store, trajectories });
    const trace = [
      { t: 0, kind: "llm_call" as const, model: "m", cost: { inputTokens: 1, outputTokens: 1, usd: 0.01 } },
    ];
    await store.create({
      id: "r-embed",
      tenant: "acme",
      harness: { id: "h", version: "1" },
      caseId: "c1",
      status: "succeeded",
      result: {
        caseId: "c1",
        harness: "h@1",
        trace,
        snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "x" },
        scores: [],
      },
      createdAt: "t",
      updatedAt: "t",
    });
    // No sealed copy yet → the embed answers, marked as such.
    const viaEmbed = await service.trajectory("acme", "r-embed");
    expect(viaEmbed?.meta.source).toBe("embed");
    expect(viaEmbed?.events).toHaveLength(1);
    // Sealed copy present → it serves (the owned record outranks the row embed).
    await trajectories.seal({ runId: "r-embed", tenant: "acme", source: "run", events: trace });
    expect((await service.trajectory("acme", "r-embed"))?.meta.source).toBe("run");
    // Workspace scoping — a foreign tenant reads nothing.
    expect(await service.trajectory("rival", "r-embed")).toBeUndefined();
  });
});

describe("POST /internal/activations/admit — the §5.1 activation gate bridge", () => {
  function withGate(exhausted: Set<string>) {
    const app = buildServer({
      service: svc(),
      internalToken: "itok",
      admitActivation: (tenant: string) => {
        if (exhausted.has(tenant))
          throw new PaymentRequiredError("BUDGET_EXCEEDED", { tenant }, "cost budget exceeded");
      },
    });
    return app;
  }

  it("admits within budget and answers 402 BUDGET_EXCEEDED past it (the activator skips visibly)", async () => {
    const app = withGate(new Set(["broke"]));
    const ok = await app.inject({
      method: "POST",
      url: "/internal/activations/admit",
      headers: { "x-internal-token": "itok" },
      payload: { tenant: "acme" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ admitted: true });

    const refused = await app.inject({
      method: "POST",
      url: "/internal/activations/admit",
      headers: { "x-internal-token": "itok" },
      payload: { tenant: "broke" },
    });
    expect(refused.statusCode).toBe(402);
    expect(refused.json()).toMatchObject({ code: "BUDGET_EXCEEDED" });
  });

  it("is token-guarded and absent without the capability", async () => {
    const app = withGate(new Set());
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/internal/activations/admit",
          headers: { "x-internal-token": "wrong" },
          payload: { tenant: "acme" },
        })
      ).statusCode,
    ).toBe(403);
    const bare = buildServer({ service: svc(), internalToken: "itok" });
    expect(
      (
        await bare.inject({
          method: "POST",
          url: "/internal/activations/admit",
          headers: { "x-internal-token": "itok" },
          payload: { tenant: "acme" },
        })
      ).statusCode,
    ).toBe(404);
  });
});
