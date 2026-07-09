import { describe, expect, it } from "vitest";
import { InProcessCallbackRendezvous } from "./callback-rendezvous.js";

describe("InProcessCallbackRendezvous", () => {
  it("url(runId) = baseUrl/runId (per-run callback address)", () => {
    expect(new InProcessCallbackRendezvous("http://cb/frontdoor/").url("run-4")).toBe("http://cb/frontdoor/run-4");
    expect(new InProcessCallbackRendezvous("http://cb/frontdoor").url("run-4")).toBe("http://cb/frontdoor/run-4");
  });

  it("when deliver comes before wait, it is queued and returned immediately", async () => {
    const r = new InProcessCallbackRendezvous("http://cb");
    r.deliver("run-1", { a: 1 });
    expect(await r.wait("run-1", 1000)).toEqual({ body: { a: 1 } });
  });

  it("when wait comes first, deliver wakes the waiter", async () => {
    const r = new InProcessCallbackRendezvous("http://cb");
    const pending = r.wait("run-2", 1000);
    r.deliver("run-2", { b: 2 });
    expect(await pending).toEqual({ body: { b: 2 } });
  });

  it("multiple delivers are consumed FIFO", async () => {
    const r = new InProcessCallbackRendezvous("http://cb");
    r.deliver("r", { n: 1 });
    r.deliver("r", { n: 2 });
    expect(await r.wait("r", 1000)).toEqual({ body: { n: 1 } });
    expect(await r.wait("r", 1000)).toEqual({ body: { n: 2 } });
  });

  it("returns undefined (=timeout) when no deliver arrives within timeoutMs", async () => {
    const r = new InProcessCallbackRendezvous("http://cb");
    expect(await r.wait("run-3", 5)).toBeUndefined();
  });

  it("is isolated per run — a deliver for a different runId does not wake it", async () => {
    const r = new InProcessCallbackRendezvous("http://cb");
    r.deliver("other", { x: 1 });
    expect(await r.wait("mine", 5)).toBeUndefined(); // mine gets nothing
    expect(await r.wait("other", 1000)).toEqual({ body: { x: 1 } }); // the other queue remains
  });
});
