import { describe, expect, it } from "vitest";
import type { CdpSocket } from "./capture-cdp.js";
import { resetBrowserState } from "./reset-browser.js";

// A fake CDP page socket — records sent commands and replies to each id (navigate id=3 completes the reset). Mirrors
// a real WebSocket's ordering: `open` fires on a microtask AFTER the caller has registered its listeners (the caller
// registers open then message synchronously), and each send schedules its reply on a later microtask.
function fakeSocket(behavior: "ok" | "error" | { errorIds: number[] } = "ok") {
  const sent: Array<{ id: number; method: string; params?: Record<string, unknown> }> = [];
  let onMessage: ((ev: { data: unknown }) => void) | undefined;
  const errors = (id: number) =>
    behavior === "error" ? true : typeof behavior === "object" ? behavior.errorIds.includes(id) : false;
  const ws: CdpSocket = {
    send(data: string) {
      const cmd = JSON.parse(data) as { id: number; method: string; params?: Record<string, unknown> };
      sent.push(cmd);
      const reply = errors(cmd.id) ? { id: cmd.id, error: { message: "boom" } } : { id: cmd.id, result: {} };
      queueMicrotask(() => onMessage?.({ data: JSON.stringify(reply) }));
    },
    close() {},
    addEventListener(type: string, cb: (arg?: unknown) => void) {
      if (type === "open") queueMicrotask(() => (cb as () => void)()); // fire open after listeners are registered
      if (type === "message") onMessage = cb as (ev: { data: unknown }) => void;
    },
  } as unknown as CdpSocket;
  return { ws, sent };
}

// /json lists the given page targets; /json/close/<id> is recorded so we can assert extra tabs get closed.
function fakeFetch(pages: Array<{ id: string; type: string; ws: string }>, closed: string[]) {
  return (async (url: string) => {
    const u = String(url);
    if (u.endsWith("/json")) {
      return new Response(JSON.stringify(pages.map((p) => ({ id: p.id, type: p.type, webSocketDebuggerUrl: p.ws }))), {
        status: 200,
      });
    }
    const close = u.match(/\/json\/close\/(.+)$/);
    if (close?.[1]) closed.push(close[1]);
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
}

describe("resetBrowserState (pooled browser re-lease wipe)", () => {
  it("clears cookies + storage and blanks the page so the next lease starts clean", async () => {
    const { ws, sent } = fakeSocket("ok");
    const closed: string[] = [];
    await resetBrowserState("http://browser:9222", {
      fetch: fakeFetch([{ id: "p1", type: "page", ws: "ws://browser:9222/devtools/page/p1" }], closed),
      connect: () => ws,
    });
    const methods = sent.map((c) => c.method);
    expect(methods).toContain("Network.clearBrowserCookies");
    expect(methods).toContain("Storage.clearDataForOrigin");
    expect(methods).toContain("Page.navigate");
    expect(sent.find((c) => c.method === "Page.navigate")?.params).toMatchObject({ url: "about:blank" });
  });

  it("closes every extra tab the session left behind, keeping one to drive the reset", async () => {
    const { ws } = fakeSocket("ok");
    const closed: string[] = [];
    await resetBrowserState("http://browser:9222", {
      fetch: fakeFetch(
        [
          { id: "p1", type: "page", ws: "ws://browser:9222/devtools/page/p1" },
          { id: "p2", type: "page", ws: "ws://browser:9222/devtools/page/p2" },
          { id: "p3", type: "page", ws: "ws://browser:9222/devtools/page/p3" },
        ],
        closed,
      ),
      connect: () => ws,
    });
    expect(closed).toEqual(["p2", "p3"]); // p1 is kept to run the reset commands on
  });

  it("rejects (so the caller quarantines the member) when a CDP command errors", async () => {
    const { ws } = fakeSocket("error");
    const closed: string[] = [];
    await expect(
      resetBrowserState("http://browser:9222", {
        fetch: fakeFetch([{ id: "p1", type: "page", ws: "ws://browser:9222/devtools/page/p1" }], closed),
        connect: () => ws,
      }),
    ).rejects.toThrow(/boom/);
  });

  it("tolerates a storage-clear error (origin '*' is not accepted by every Chromium) — cookies are the fatal wipe", async () => {
    const { ws, sent } = fakeSocket({ errorIds: [2] }); // only Storage.clearDataForOrigin errors
    const closed: string[] = [];
    await resetBrowserState("http://browser:9222", {
      fetch: fakeFetch([{ id: "p1", type: "page", ws: "ws://browser:9222/devtools/page/p1" }], closed),
      connect: () => ws,
    });
    expect(sent.map((c) => c.method)).toContain("Network.clearBrowserCookies"); // the reset still completed
  });

  it("throws when the browser exposes no page target to reset", async () => {
    const closed: string[] = [];
    await expect(
      resetBrowserState("http://browser:9222", {
        fetch: fakeFetch([], closed),
        connect: () => {
          throw new Error("should not connect");
        },
      }),
    ).rejects.toThrow(/No CDP page target/);
  });
});
