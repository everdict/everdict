import type { CdpSocket } from "@everdict/topology";
import { describe, expect, it, vi } from "vitest";
import { PooledBrowserProvisioner } from "./pooled-browser-provisioner.js";

// A page socket that ANSWERS the liveness probe (see ensureLivePageTarget) — the shape a real, open target has.
function answeringSocket(answers = true): (url: string) => CdpSocket {
  return () => {
    const listeners: Record<string, Array<(ev?: unknown) => void>> = { open: [], message: [], error: [] };
    const socket: CdpSocket = {
      send: () => {
        if (answers)
          setTimeout(() => {
            for (const cb of listeners.message ?? []) cb({ data: '{"id":1,"result":{}}' });
          }, 0);
      },
      close: () => {},
      addEventListener: (type: string, cb: (ev?: unknown) => void) => {
        const bucket = listeners[type] ?? [];
        listeners[type] = bucket;
        bucket.push(cb);
        if (type === "open") setTimeout(() => cb(), 0);
      },
    } as unknown as CdpSocket;
    return socket;
  };
}

// A fetch that reports every member's CDP as up, with one existing page target (so no /json/new is needed).
const okFetch = (async (url: string) => {
  const u = String(url);
  if (u.endsWith("/json/version")) return new Response('{"Browser":"HeadlessChrome"}', { status: 200 });
  if (u.endsWith("/json")) return new Response('[{"type":"page","webSocketDebuggerUrl":"ws://x/p"}]', { status: 200 });
  return new Response("ok", { status: 200 });
}) as unknown as typeof fetch;

describe("PooledBrowserProvisioner (browser-profiles remote pool)", () => {
  it("leases a free member and returns its reachable CDP base — no docker socket involved", async () => {
    const p = new PooledBrowserProvisioner({
      pool: ["http://browser:9222"],
      fetch: okFetch,
      connect: answeringSocket(),
      reset: async () => {},
    });
    const browser = await p.provision();
    expect(browser.cdpBase).toBe("http://browser:9222");
  });

  it("hands each concurrent session a DISTINCT member (one browser per session)", async () => {
    const p = new PooledBrowserProvisioner({
      pool: ["http://b1:9222", "http://b2:9222"],
      fetch: okFetch,
      connect: answeringSocket(),
      reset: async () => {},
    });
    const a = await p.provision();
    const b = await p.provision();
    expect(new Set([a.cdpBase, b.cdpBase]).size).toBe(2);
  });

  it("429s once every member is leased (composes with the S8 caps)", async () => {
    const p = new PooledBrowserProvisioner({
      pool: ["http://b1:9222"],
      fetch: okFetch,
      connect: answeringSocket(),
      reset: async () => {},
    });
    await p.provision();
    await expect(p.provision()).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("wipes a member on dispose and returns it to the pool for re-lease", async () => {
    const reset = vi.fn(async () => {});
    const p = new PooledBrowserProvisioner({
      pool: ["http://b1:9222"],
      fetch: okFetch,
      connect: answeringSocket(),
      reset,
    });
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
    const p = new PooledBrowserProvisioner({
      pool: ["http://b1:9222"],
      fetch: okFetch,
      connect: answeringSocket(),
      reset,
      log: () => {},
    });
    const first = await p.provision();
    await first.dispose(); // reset throws → member quarantined, not freed
    // The next lease re-runs the WIPE rather than handing the dirty browser over. It still fails, so nobody
    // gets it — and the refusal says the pool is broken, not busy: waiting fixes congestion and never fixes this.
    const err = await p.provision().catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "UPSTREAM_ERROR" });
    expect(String(err)).toMatch(/quarantined and could not be wiped clean/);
  });

  // ── A QUARANTINE IS A STATE TO LEAVE, NOT A GRAVE (§5.4/§7.3) ──────────────────────────────────────
  it("returns a quarantined member to service once its wipe succeeds — one bad release is not the pool's death", async () => {
    let attempt = 0;
    const reset = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("a tab closed mid-reset"); // the transient failure that used to be permanent
    });
    const logged: string[] = [];
    const p = new PooledBrowserProvisioner({
      pool: ["http://b1:9222"],
      fetch: okFetch,
      connect: answeringSocket(),
      reset,
      log: (m) => logged.push(m),
    });
    await (await p.provision()).dispose(); // quarantined
    const second = await p.provision(); // re-wiped, proven clean, handed over
    expect(second.cdpBase).toBe("http://b1:9222");
    expect(reset).toHaveBeenCalledTimes(2); // it was PROVEN clean, not simply forgiven
    expect(logged.some((m) => m.includes("returned to service"))).toBe(true);
  });

  it("refuses a member whose only page target is a ghost — a listed target that never answers", async () => {
    const p = new PooledBrowserProvisioner({
      pool: ["http://b1:9222"],
      fetch: okFetch,
      connect: answeringSocket(false), // opens in ~2ms, then silence — exactly what a just-closed target does
      reset: async () => {},
      log: () => {},
    });
    // Previously `some(t => t.type === "page")` was the whole check, so this member was handed out unusable.
    await expect(p.provision()).rejects.toThrow(/none of them answers/);
  });

  it("rejects a geo-proxied request rather than running the login un-proxied", async () => {
    const p = new PooledBrowserProvisioner({
      pool: ["http://b1:9222"],
      fetch: okFetch,
      connect: answeringSocket(),
      reset: async () => {},
    });
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
    await expect(p.provision()).rejects.toThrow(/did not become ready/);
    // the lease was freed (not stuck) — a later provision can retry the same member
    const okAgain = new PooledBrowserProvisioner({
      pool: ["http://b1:9222"],
      fetch: okFetch,
      connect: answeringSocket(),
      reset: async () => {},
    });
    expect((await okAgain.provision()).cdpBase).toBe("http://b1:9222");
  });

  it("refuses an empty pool at construction", () => {
    expect(() => new PooledBrowserProvisioner({ pool: [] })).toThrow(/empty/);
  });

  // ── THE FREE LIST IS A PRIORITY LIST — the lease WALKS the members instead of dying on the first (§5.1) ──
  describe("walking the free members in pool order", () => {
    // A fetch where members named "dead" are unreachable and everything else answers like okFetch — the
    // heterogeneous pool: one sidecar the control plane cannot reach, the rest fine.
    const partialFetch = (async (url: string) => {
      const u = String(url);
      if (u.includes("//dead")) throw new Error("connection refused");
      return (okFetch as unknown as (u: string) => Promise<Response>)(u);
    }) as unknown as typeof fetch;

    it("leases the second member when the first is unreachable — a dead sidecar costs one short probe, not the provision", async () => {
      const p = new PooledBrowserProvisioner({
        pool: ["http://dead:9222", "http://live:9222"],
        fetch: partialFetch,
        connect: answeringSocket(),
        reset: async () => {},
        candidateProbeMs: 20, // keep the walk fast in the test; the default is 1.5s
      });
      const browser = await p.provision();
      expect(browser.cdpBase).toBe("http://live:9222");
    });

    it("names how many candidates were tried when every free member is dead — and none of them is quarantined for it", async () => {
      const downFetch = (async () => {
        throw new Error("connection refused");
      }) as unknown as typeof fetch;
      const p = new PooledBrowserProvisioner({
        pool: ["http://b1:9222", "http://b2:9222"],
        fetch: downFetch,
        reset: async () => {},
        candidateProbeMs: 20,
        readyTimeoutMs: 30, // the last candidate's full patience, shortened for the test
      });
      const err = await p.provision().catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "UPSTREAM_ERROR" });
      expect(String(err)).toMatch(/tried 2 of 2 free members/);
      // The last attempt's diagnostics survive the walk — silence still reads as silence, not a blank.
      expect(String(err)).toMatch(/did not become ready/);
      // Unreachable is NOT dirty: a failed probe never quarantines, so a retry still sees a busy-free pool
      // (both members walked again), not "every pooled browser is quarantined".
      const again = await p.provision().catch((e: unknown) => e);
      expect(String(again)).toMatch(/tried 2 of 2 free members/);
      expect(String(again)).not.toMatch(/quarantined/);
    });

    it("keeps pool order as priority order — a healthy first member is chosen, no probing beyond it", async () => {
      const p = new PooledBrowserProvisioner({
        pool: ["http://live:9222", "http://dead:9222"],
        fetch: partialFetch,
        connect: answeringSocket(),
        reset: async () => {},
        candidateProbeMs: 20,
      });
      const browser = await p.provision();
      expect(browser.cdpBase).toBe("http://live:9222");
    });
  });
});
