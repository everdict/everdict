import { createHmac } from "node:crypto";
import type { PlatformEventRecord, SubscriptionRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { SubscriptionStore } from "../ports/subscription-store.js";
import { subscriptionReactionConsumer } from "./subscription-reaction-consumer.js";

// Map-backed fake (the real InMemory* impls live in @everdict/db, which application-control must not import).
class FakeSubscriptionStore implements SubscriptionStore {
  constructor(private readonly rows: SubscriptionRecord[]) {}
  async create(): Promise<void> {}
  async get(): Promise<SubscriptionRecord | undefined> {
    return undefined;
  }
  async list(tenant: string): Promise<SubscriptionRecord[]> {
    return this.rows.filter((r) => r.tenant === tenant);
  }
  async listEnabled(tenant: string): Promise<SubscriptionRecord[]> {
    return (await this.list(tenant)).filter((r) => r.governance.enabled);
  }
  async update(): Promise<SubscriptionRecord | undefined> {
    return undefined;
  }
  async remove(): Promise<void> {}
}

const subscription = (over: Partial<SubscriptionRecord> = {}): SubscriptionRecord => ({
  id: "sub-1",
  tenant: "acme",
  name: "hook",
  selector: { kinds: ["scorecard.completed"], filters: [] },
  reaction: { kind: "webhook", url: "https://hooks.example.com/x" },
  governance: { enabled: true },
  createdBy: "member",
  createdAt: "2026-07-30T00:00:00.000Z",
  updatedAt: "2026-07-30T00:00:00.000Z",
  ...over,
});

const event = (over: Partial<PlatformEventRecord> = {}): PlatformEventRecord => ({
  id: "ev-1",
  seq: 1,
  tenant: "acme",
  kind: "scorecard.completed",
  subject: { type: "scorecard", id: "sc-1" },
  payload: { passRate: 0.5 },
  message: "Scorecard completed",
  createdAt: "2026-07-30T00:00:01.000Z",
  ...over,
});

function fakeFetch(status = 200) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const impl = (async (input: URL | string | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? init.body : "",
    });
    return new Response("", { status });
  }) as typeof fetch;
  return { calls, impl };
}

describe("subscriptionReactionConsumer — non-agent reactions ride the E1 cursor (E3)", () => {
  it("delivers a matching fact to the webhook with the event id and an HMAC signature", async () => {
    const { calls, impl } = fakeFetch();
    const consumer = subscriptionReactionConsumer({
      subscriptions: new FakeSubscriptionStore([
        subscription({ reaction: { kind: "webhook", url: "https://hooks.example.com/x", secret: "s3cret-key" } }),
      ]),
      fetchImpl: impl,
    });
    await consumer.handle(event());
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe("https://hooks.example.com/x");
    expect(call?.headers["x-everdict-event"]).toBe("ev-1");
    const expected = `sha256=${createHmac("sha256", "s3cret-key")
      .update(call?.body ?? "", "utf8")
      .digest("hex")}`;
    expect(call?.headers["x-everdict-signature"]).toBe(expected);
    expect(JSON.parse(call?.body ?? "{}")).toMatchObject({ kind: "scorecard.completed", subject: { id: "sc-1" } });
  });

  it("skips non-matching selectors, disabled rules, and agent reactions (the activation engine's jurisdiction)", async () => {
    const { calls, impl } = fakeFetch();
    const consumer = subscriptionReactionConsumer({
      subscriptions: new FakeSubscriptionStore([
        subscription({ id: "s-kind", selector: { kinds: ["run.failed"], filters: [] } }),
        subscription({
          id: "s-filter",
          selector: { kinds: ["scorecard.completed"], filters: [{ field: "passRate", op: "eq", value: 1 }] },
        }),
        subscription({ id: "s-off", governance: { enabled: false } }),
        subscription({ id: "s-agent", reaction: { kind: "agent", agentId: "triage" } }),
      ]),
      fetchImpl: impl,
    });
    await consumer.handle(event());
    expect(calls).toHaveLength(0);
  });

  it("a failing endpoint throws (the runner's retry → dead-letter path), and cooldownSec paces re-fires", async () => {
    const failing = fakeFetch(500);
    const consumer = subscriptionReactionConsumer({
      subscriptions: new FakeSubscriptionStore([subscription()]),
      fetchImpl: failing.impl,
    });
    await expect(consumer.handle(event())).rejects.toThrow(/answered 500/);

    let clock = 0;
    const paced = fakeFetch();
    const pacedConsumer = subscriptionReactionConsumer({
      subscriptions: new FakeSubscriptionStore([subscription({ governance: { enabled: true, cooldownSec: 60 } })]),
      fetchImpl: paced.impl,
      now: () => clock,
    });
    await pacedConsumer.handle(event({ id: "ev-1" }));
    clock = 30_000;
    await pacedConsumer.handle(event({ id: "ev-2" })); // inside the window — suppressed
    clock = 61_000;
    await pacedConsumer.handle(event({ id: "ev-3" }));
    expect(paced.calls.map((c) => c.headers["x-everdict-event"])).toEqual(["ev-1", "ev-3"]);
  });

  it("a workflow reaction starts the durable executor when wired, and is a visible no-op without one", async () => {
    const started: Array<{ eventId: string; subscriptionId: string }> = [];
    const withExecutor = subscriptionReactionConsumer({
      subscriptions: new FakeSubscriptionStore([
        subscription({ reaction: { kind: "workflow", steps: [{ agentId: "triage" }, { agentId: "fixer" }] } }),
      ]),
      startReactionWorkflow: async (input) => {
        started.push({ eventId: input.eventId, subscriptionId: input.subscriptionId });
      },
    });
    await withExecutor.handle(event());
    expect(started).toEqual([{ eventId: "ev-1", subscriptionId: "sub-1" }]);

    const withoutExecutor = subscriptionReactionConsumer({
      subscriptions: new FakeSubscriptionStore([
        subscription({ reaction: { kind: "workflow", steps: [{ agentId: "triage" }] } }),
      ]),
    });
    await expect(withoutExecutor.handle(event())).resolves.toBeUndefined(); // skip, never a half-run
  });
});
