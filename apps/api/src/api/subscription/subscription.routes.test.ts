import { RunService, SubscriptionService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import { InMemoryRunStore, InMemorySubscriptionStore } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../server.js";

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused in subscription tests");
  },
};

const H = { "x-everdict-tenant": "acme" };

function build(opts?: { agents?: string[] }) {
  const app = buildServer({
    service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    subscriptionService: new SubscriptionService({
      store: new InMemorySubscriptionStore(),
      ...(opts?.agents !== undefined
        ? { agentExists: async (_tenant: string, agentId: string) => (opts.agents ?? []).includes(agentId) }
        : {}),
    }),
  });
  return { app };
}

const webhookBody = {
  name: "notify CI",
  selector: { kinds: ["scorecard.completed"], filters: [{ field: "passRate", op: "lt", value: 1 }] },
  reaction: { kind: "webhook", url: "https://hooks.example.com/everdict" },
};

describe("subscriptions — event → reaction rules (E3 §6)", () => {
  it("a member creates, lists, updates, and deletes a subscription (round-trip)", async () => {
    const { app } = build();
    const created = await app.inject({ method: "POST", url: "/subscriptions", headers: H, payload: webhookBody });
    expect(created.statusCode).toBe(201);
    const record = created.json();
    expect(record).toMatchObject({ name: "notify CI", governance: { enabled: true } });

    const listed = await app.inject({ method: "GET", url: "/subscriptions", headers: H });
    expect(listed.json()).toHaveLength(1);

    const updated = await app.inject({
      method: "PATCH",
      url: `/subscriptions/${record.id}`,
      headers: H,
      payload: { governance: { enabled: false, cooldownSec: 600 } },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().governance).toEqual({ enabled: false, cooldownSec: 600 });

    const deleted = await app.inject({ method: "DELETE", url: `/subscriptions/${record.id}`, headers: H });
    expect(deleted.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/subscriptions", headers: H })).json()).toHaveLength(0);
  });

  it("rejects a malformed body (unknown reaction kind / non-triggerable event kind) with 400", async () => {
    const { app } = build();
    const badReaction = await app.inject({
      method: "POST",
      url: "/subscriptions",
      headers: H,
      payload: { ...webhookBody, reaction: { kind: "carrier-pigeon" } },
    });
    expect(badReaction.statusCode).toBe(400);
    // agent.run.* is deliberately NOT trigger-matchable (agents watching agents is the runaway vector).
    const badKind = await app.inject({
      method: "POST",
      url: "/subscriptions",
      headers: H,
      payload: { ...webhookBody, selector: { kinds: ["agent.run.completed"], filters: [] } },
    });
    expect(badKind.statusCode).toBe(400);
  });

  it("an agent-targeting reaction is validated against the registry (missing agent → 404)", async () => {
    const { app } = build({ agents: ["triage"] });
    const missing = await app.inject({
      method: "POST",
      url: "/subscriptions",
      headers: H,
      payload: { ...webhookBody, reaction: { kind: "agent", agentId: "ghost" } },
    });
    expect(missing.statusCode).toBe(404);
    const ok = await app.inject({
      method: "POST",
      url: "/subscriptions",
      headers: H,
      payload: { ...webhookBody, reaction: { kind: "workflow", steps: [{ agentId: "triage" }] } },
    });
    expect(ok.statusCode).toBe(201);
  });

  it("stays workspace-scoped: another tenant sees nothing and its mutations read 404", async () => {
    const { app } = build();
    const created = await app.inject({ method: "POST", url: "/subscriptions", headers: H, payload: webhookBody });
    const id = created.json().id;
    const rival = { "x-everdict-tenant": "rival" };
    expect((await app.inject({ method: "GET", url: "/subscriptions", headers: rival })).json()).toHaveLength(0);
    expect(
      (await app.inject({ method: "PATCH", url: `/subscriptions/${id}`, headers: rival, payload: { name: "steal" } }))
        .statusCode,
    ).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/subscriptions/${id}`, headers: rival })).statusCode).toBe(404);
  });

  it("is absent (404) when no subscription service is configured", async () => {
    const app = buildServer({
      service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    });
    expect((await app.inject({ method: "GET", url: "/subscriptions", headers: H })).statusCode).toBe(404);
  });
});

describe("reaction internal bridge (T-d — worker activity → CP → agent service)", () => {
  function buildWithBridge() {
    const started: unknown[] = [];
    const app = buildServer({
      service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
      internalToken: "shhh",
      reactionBridge: {
        start: async (input) => {
          started.push(input);
          return { status: 200, body: { sessionId: "sess-1", started: true } };
        },
        status: async (_ws, sessionId) => ({
          status: 200,
          body: { status: sessionId === "sess-1" ? "completed" : "pending" },
        }),
      },
    });
    return { app, started };
  }

  const stepBody = {
    tenant: "acme",
    agentId: "triage",
    eventId: "ev-1#s0",
    subscriptionId: "sub-1",
    eventKind: "scorecard.completed",
    message: "Scorecard regressed",
  };

  it("forwards a step start to the agent bridge (workspace renamed from tenant) and mirrors the answer", async () => {
    const { app, started } = buildWithBridge();
    const res = await app.inject({
      method: "POST",
      url: "/internal/reactions/step",
      headers: { "x-internal-token": "shhh" },
      payload: stepBody,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sessionId: "sess-1", started: true });
    expect(started[0]).toMatchObject({ workspace: "acme", agentId: "triage", eventId: "ev-1#s0" });

    const status = await app.inject({
      method: "GET",
      url: "/internal/reactions/step-status?tenant=acme&sessionId=sess-1",
      headers: { "x-internal-token": "shhh" },
    });
    expect(status.json()).toEqual({ status: "completed" });
  });

  it("is token-guarded (403 on mismatch) and absent (404) without a configured bridge", async () => {
    const { app } = buildWithBridge();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/internal/reactions/step",
          headers: { "x-internal-token": "wrong" },
          payload: stepBody,
        })
      ).statusCode,
    ).toBe(403);

    const bare = buildServer({
      service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
      internalToken: "shhh",
    });
    expect(
      (
        await bare.inject({
          method: "POST",
          url: "/internal/reactions/step",
          headers: { "x-internal-token": "shhh" },
          payload: stepBody,
        })
      ).statusCode,
    ).toBe(404);
  });
});
