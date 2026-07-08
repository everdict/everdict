import { InMemoryCallbackStore } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { StoreCallbackRendezvous } from "./store-callback-rendezvous.js";

describe("StoreCallbackRendezvous — multi-replica callback completion", () => {
  const fast = { pollMs: 1, sleep: async () => {} };

  it("a body delivered on ANOTHER instance is claimed by the waiter (shared store = cross-replica rendezvous)", async () => {
    const store = new InMemoryCallbackStore();
    const receiverReplica = new StoreCallbackRendezvous("http://cp/frontdoor-callback", store, fast);
    const drivingReplica = new StoreCallbackRendezvous("http://cp/frontdoor-callback", store, fast);

    receiverReplica.deliver("run-1", { status: "done", answer: 42 }); // POST landed on replica A
    const got = await drivingReplica.wait("run-1", 1000); // replica B is driving the run
    expect(got).toEqual({ body: { status: "done", answer: 42 } });
  });

  it("wait-then-deliver: the poll picks the body up as soon as it lands", async () => {
    const store = new InMemoryCallbackStore();
    const rendezvous = new StoreCallbackRendezvous("http://cp/frontdoor-callback", store, {
      pollMs: 1,
      sleep: async () => {
        // deliver mid-poll (after the first empty claim)
        rendezvous.deliver("run-2", { ok: true });
      },
    });
    const got = await rendezvous.wait("run-2", 1000);
    expect(got).toEqual({ body: { ok: true } });
  });

  it("each body is consumed exactly once (two waiters never share one callback)", async () => {
    const store = new InMemoryCallbackStore();
    const a = new StoreCallbackRendezvous("http://cp/frontdoor-callback", store, fast);
    a.deliver("run-3", { n: 1 });
    expect(await a.wait("run-3", 50)).toEqual({ body: { n: 1 } });
    expect(await a.wait("run-3", 5)).toBeUndefined(); // already claimed
  });

  it("times out with undefined when nothing arrives; url() mirrors the in-process shape", async () => {
    const store = new InMemoryCallbackStore();
    const r = new StoreCallbackRendezvous("http://cp/frontdoor-callback/", store, fast);
    expect(await r.wait("ghost", 5)).toBeUndefined();
    expect(r.url("run-9")).toBe("http://cp/frontdoor-callback/run-9");
  });
});
