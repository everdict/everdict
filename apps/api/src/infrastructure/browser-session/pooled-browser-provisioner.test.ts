import { describe, expect, it, vi } from "vitest";
import { PooledBrowserProvisioner } from "./pooled-browser-provisioner.js";

// A fetch that reports every member's CDP as up, with one existing page target (so no /json/new is needed).
const okFetch = (async (url: string) => {
  const u = String(url);
  if (u.endsWith("/json/version")) return new Response('{"Browser":"HeadlessChrome"}', { status: 200 });
  if (u.endsWith("/json")) return new Response('[{"type":"page","webSocketDebuggerUrl":"ws://x/p"}]', { status: 200 });
  return new Response("ok", { status: 200 });
}) as unknown as typeof fetch;

describe("PooledBrowserProvisioner (browser-profiles remote pool)", () => {
  it("leases a free member and returns its reachable CDP base — no docker socket involved", async () => {
    const p = new PooledBrowserProvisioner({ pool: ["http://browser:9222"], fetch: okFetch, reset: async () => {} });
    const browser = await p.provision();
    expect(browser.cdpBase).toBe("http://browser:9222");
  });

  it("hands each concurrent session a DISTINCT member (one browser per session)", async () => {
    const p = new PooledBrowserProvisioner({
      pool: ["http://b1:9222", "http://b2:9222"],
      fetch: okFetch,
      reset: async () => {},
    });
    const a = await p.provision();
    const b = await p.provision();
    expect(new Set([a.cdpBase, b.cdpBase]).size).toBe(2);
  });

  it("429s once every member is leased (composes with the S8 caps)", async () => {
    const p = new PooledBrowserProvisioner({ pool: ["http://b1:9222"], fetch: okFetch, reset: async () => {} });
    await p.provision();
    await expect(p.provision()).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("wipes a member on dispose and returns it to the pool for re-lease", async () => {
    const reset = vi.fn(async () => {});
    const p = new PooledBrowserProvisioner({ pool: ["http://b1:9222"], fetch: okFetch, reset });
    const first = await p.provision();
    await first.dispose();
    expect(reset).toHaveBeenCalledWith("http://b1:9222");
    const second = await p.provision(); // free again
    expect(second.cdpBase).toBe("http://b1:9222");
  });

  it("QUARANTINES a member whose reset fails — never re-leases a browser it can't prove clean", async () => {
    const reset = vi.fn(async () => {
      throw new Error("reset failed");
    });
    const p = new PooledBrowserProvisioner({ pool: ["http://b1:9222"], fetch: okFetch, reset });
    const first = await p.provision();
    await first.dispose(); // reset throws → member quarantined, not freed
    await expect(p.provision()).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("rejects a geo-proxied request rather than running the login un-proxied", async () => {
    const p = new PooledBrowserProvisioner({ pool: ["http://b1:9222"], fetch: okFetch, reset: async () => {} });
    await expect(p.provision({ proxyServer: "http://proxy:8080" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("frees the lease and throws if the member's CDP never responds", async () => {
    const downFetch = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    const p = new PooledBrowserProvisioner({
      pool: ["http://b1:9222"],
      fetch: downFetch,
      reset: async () => {},
      readyTimeoutMs: 30,
    });
    await expect(p.provision()).rejects.toThrow(/did not respond/);
    // the lease was freed (not stuck) — a later provision can retry the same member
    const okAgain = new PooledBrowserProvisioner({ pool: ["http://b1:9222"], fetch: okFetch, reset: async () => {} });
    expect((await okAgain.provision()).cdpBase).toBe("http://b1:9222");
  });

  it("refuses an empty pool at construction", () => {
    expect(() => new PooledBrowserProvisioner({ pool: [] })).toThrow(/empty/);
  });
});
