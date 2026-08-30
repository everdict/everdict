import { describe, expect, it } from "vitest";
import type { CdpSocket } from "./capture-cdp.js";
import { ensureLivePageTarget, pickLivePageTarget } from "./live-target.js";

// A socket that behaves like the two targets this fix exists to tell apart: a live one answers, and a target
// closed a moment ago OPENS and then says nothing (measured: ~2ms to open, no reply ever).
function socketFor(answering: (url: string) => boolean): (url: string) => CdpSocket {
  return (url: string) => {
    const listeners: Record<string, Array<(ev?: unknown) => void>> = {};
    const socket = {
      send: () => {
        if (!answering(url)) return; // the ghost: silence, not an error
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
    };
    return socket as unknown as CdpSocket;
  };
}

// ── THE PROBE BUDGET IS BOUNDED ON BOTH SIDES, SO IT IS NAMED ────────────────────────────────────────
//
// `probeMs` plays two roles at once here, because `pickLivePageTarget` probes candidates SEQUENTIALLY: a
// ghost has to be waited OUT before the live candidate is reached, and the live one has to answer INSIDE
// the same budget. So the number is constrained from both directions:
//
//   too small — a loaded machine's scheduling latency outruns the socket double's reply (open and message
//               are two `setTimeout(…, 0)` hops), so a LIVE target reads as a ghost
//   too large — every ghost is waited out at that price, and the slowest test here waits out two
//
// 20ms satisfied both on an idle machine and neither under the commit gate, which runs every package's
// suite at once: the probe expired first, and the failure surfaced as "none of them answers" — a busy
// machine wearing the shape of a product defect, which is the worst way for a timing test to fail.
//
// 500ms is `DEFAULT_PROBE_MS`, the value production sizes against a measured ~205ms linger. The slowest
// test waits out two ghosts, so this file costs about a second and no longer asks how loaded the box is.
const PROBE_MS = 500;

const GHOST = { type: "page", url: "https://shop.example/cart", webSocketDebuggerUrl: "ws://b/devtools/page/dead" };
const LIVE = { type: "page", url: "https://shop.example/", webSocketDebuggerUrl: "ws://b/devtools/page/live" };

describe("pickLivePageTarget — a listed target is a candidate, not a page", () => {
  it("skips the ghost the listing still advertises and picks one that answers", async () => {
    // The listing's own preference order puts the ghost first (most recently active, non-blank) — which is
    // precisely why every selection site handed it out.
    const picked = await pickLivePageTarget([GHOST, LIVE], "http://b:9222", {
      connect: socketFor((url) => url.includes("live")),
      probeMs: PROBE_MS,
    });
    expect(picked).toBe(LIVE);
  });

  it("returns nothing when every candidate is silent, rather than the first one", async () => {
    const picked = await pickLivePageTarget([GHOST], "http://b:9222", {
      connect: socketFor(() => false),
      probeMs: PROBE_MS,
    });
    expect(picked).toBeUndefined();
  });
});

describe("ensureLivePageTarget — the browser ends up with a page that answers", () => {
  function browser(states: string[][]): { fetch: typeof fetch; created: () => number } {
    let call = 0;
    let created = 0;
    const fetchImpl = (async (url: URL | string) => {
      const u = String(url);
      if (u.includes("/json/new")) {
        created += 1;
        return new Response("{}", { status: 200 });
      }
      const state = states[Math.min(call++, states.length - 1)] ?? [];
      const targets = state.map((id) => ({
        type: "page",
        url: "https://x/",
        webSocketDebuggerUrl: `ws://b/devtools/page/${id}`,
      }));
      return new Response(JSON.stringify(targets), { status: 200 });
    }) as unknown as typeof fetch;
    return { fetch: fetchImpl, created: () => created };
  }

  it("creates a page when the listing holds only ghosts, and re-lists to find it", async () => {
    const b = browser([["dead"], ["dead", "live"]]);
    const target = await ensureLivePageTarget("http://b:9222", {
      fetch: b.fetch,
      connect: socketFor((url) => url.includes("live")),
      probeMs: PROBE_MS,
    });
    expect(target.webSocketDebuggerUrl).toContain("live");
    expect(b.created()).toBe(1);
  });

  it("refuses when even the fresh listing answers nothing — an unusable browser is not handed over", async () => {
    const b = browser([["dead"]]);
    await expect(
      ensureLivePageTarget("http://b:9222", {
        fetch: b.fetch,
        connect: socketFor(() => false),
        probeMs: PROBE_MS,
      }),
    ).rejects.toThrow(/none of them answers/);
  });
});
