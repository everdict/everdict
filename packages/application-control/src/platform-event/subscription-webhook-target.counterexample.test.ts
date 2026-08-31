import type { PlatformEventRecord, SubscriptionRecord } from "@everdict/contracts";
import { describe, expect, it, vi } from "vitest";
import type { SubscriptionStore } from "../ports/subscription-store.js";
import { subscriptionReactionConsumer } from "./subscription-reaction-consumer.js";

// ── THE SIBLING LANE ASKS THE SAME QUESTION (arch-review 124) ────────────────────────────────────────
//
// `reaction.url` is member-authored (`agents:write`, so authoring is member+) and this delivery fires on
// EVERY matching event — a repeating, event-triggered dial from the control plane's network position. The
// run-webhook lane has judged its destination since arch-review 36; this one reached `fetch` directly,
// because the decision lived inside that consumer instead of where both lanes look.
//
// What this pins is not the predicate (contracts owns that) but that this LANE consults it: the difference
// between a choke point and a convention is whether each caller remembered.
const event: PlatformEventRecord = {
  id: "evt-1",
  seq: 1,
  tenant: "acme",
  kind: "run.completed",
  subject: { id: "run-1", type: "run" },
  payload: {},
  message: "a run completed",
  createdAt: "2026-08-31T00:00:00.000Z",
};

function subscriptions(url: string): SubscriptionStore {
  const record = {
    id: "sub-1",
    tenant: "acme",
    selector: { kinds: ["run.completed"], filters: [] },
    reaction: { kind: "webhook", url },
    governance: {},
  } as unknown as SubscriptionRecord;
  return {
    async listEnabled() {
      return [record];
    },
  } as unknown as SubscriptionStore;
}

describe("a subscription's webhook destination is judged before it is dialled", () => {
  // https, so the ADDRESS arm is what refuses — the scheme check would otherwise answer first and this
  // would pass without the half that matters.
  it("refuses a private address instead of dialling it", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 200 }));
    const consumer = subscriptionReactionConsumer({
      subscriptions: subscriptions("https://169.254.169.254/latest/meta-data/"),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    // Loudly — a throw is dead-lettered with the endpoint recorded; a reaction that silently never fires is
    // the failure this feature exists to remove.
    await expect(consumer.handle(event)).rejects.toThrow(/private address/);
    expect(fetchImpl, "the destination was dialled anyway").not.toHaveBeenCalled();
  });

  it("refuses plaintext http even to a public host", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 200 }));
    const consumer = subscriptionReactionConsumer({
      subscriptions: subscriptions("http://hooks.example.com/cb"),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(consumer.handle(event)).rejects.toThrow(/not https/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("still delivers to an ordinary public https endpoint", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 200 }));
    const consumer = subscriptionReactionConsumer({
      subscriptions: subscriptions("https://hooks.example.com/cb"),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await consumer.handle(event);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
