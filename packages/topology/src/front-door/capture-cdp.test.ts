import { UpstreamError } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { type CdpSocket, captureCdpDom, captureCdpScreenshot, pickPageTarget } from "./capture-cdp.js";

// A fake CDP WebSocket — replays open then a scripted reply to captureScreenshot.
function fakeSocket(reply: (sent: unknown) => unknown): { connect: (url: string) => CdpSocket; opened: string[] } {
  const opened: string[] = [];
  const connect = (url: string): CdpSocket => {
    opened.push(url);
    const msgHandlers: Array<(ev: { data: unknown }) => void> = [];
    const openHandlers: Array<() => void> = [];
    const sock: CdpSocket = {
      send(data: string) {
        const out = reply(JSON.parse(data));
        if (out !== undefined)
          queueMicrotask(() => {
            for (const h of msgHandlers) h({ data: JSON.stringify(out) });
          });
      },
      close() {},
      addEventListener(type: "message" | "open" | "error", cb: ((ev: { data: unknown }) => void) & (() => void)) {
        if (type === "message") msgHandlers.push(cb);
        else if (type === "open") {
          openHandlers.push(cb);
          queueMicrotask(() => cb());
        }
      },
    } as CdpSocket;
    return sock;
  };
  return { connect, opened };
}

const jsonList = (targets: unknown[]) =>
  (async () => new Response(JSON.stringify(targets), { status: 200 })) as unknown as typeof fetch;

describe("captureCdpScreenshot", () => {
  it("picks a page target, sends Page.captureScreenshot, returns the base64 data", async () => {
    const { connect, opened } = fakeSocket((sent) => {
      expect(sent).toMatchObject({ id: 1, method: "Page.captureScreenshot" });
      return { id: 1, result: { data: "BASE64PNG" } };
    });
    const data = await captureCdpScreenshot("http://browser:9222", {
      fetch: jsonList([
        { type: "background_page", webSocketDebuggerUrl: "ws://x/bg" },
        { type: "page", webSocketDebuggerUrl: "ws://browser:9222/page/1" },
      ]),
      connect,
    });
    expect(data).toBe("BASE64PNG");
    expect(opened).toEqual(["ws://browser:9222/page/1"]); // the page target, not the background one
  });

  it("throws when there is no CDP page target", async () => {
    await expect(
      captureCdpScreenshot("http://b:9222", {
        fetch: jsonList([{ type: "other" }]),
        connect: fakeSocket(() => ({})).connect,
      }),
    ).rejects.toBeInstanceOf(UpstreamError);
  });

  it("surfaces a CDP protocol error as UpstreamError", async () => {
    const { connect } = fakeSocket(() => ({ id: 1, error: { message: "Target closed" } }));
    await expect(
      captureCdpScreenshot("http://b:9222", {
        fetch: jsonList([{ type: "page", webSocketDebuggerUrl: "ws://b/p" }]),
        connect,
      }),
    ).rejects.toThrow(/Target closed/);
  });

  it("times out when the socket never replies", async () => {
    const { connect } = fakeSocket(() => undefined); // no reply
    await expect(
      captureCdpScreenshot("http://b:9222", {
        fetch: jsonList([{ type: "page", webSocketDebuggerUrl: "ws://b/p" }]),
        connect,
        timeoutMs: 20,
      }),
    ).rejects.toThrow(/timed out/);
  });
});

describe("captureCdpDom", () => {
  it("picks a page target, evaluates document.documentElement.outerHTML, returns the rendered HTML", async () => {
    // Regression: the browser snapshot used to set dom = JSON.stringify(targets) (the CDP target list), not the real
    // page HTML — so dom-contains / WebArena string_match / program_html couldn't grade a live front-door run.
    const html = "<html><body><h1>Order confirmed</h1><span id='total'>$42.00</span></body></html>";
    const { connect, opened } = fakeSocket((sent) => {
      expect(sent).toMatchObject({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression: "document.documentElement.outerHTML", returnByValue: true },
      });
      return { id: 1, result: { result: { type: "string", value: html } } };
    });
    const dom = await captureCdpDom("http://browser:9222", {
      fetch: jsonList([
        { type: "background_page", webSocketDebuggerUrl: "ws://x/bg" },
        { type: "page", webSocketDebuggerUrl: "ws://browser:9222/page/1" },
      ]),
      connect,
    });
    expect(dom).toBe(html);
    expect(dom).toContain("Order confirmed"); // real page content a benchmark grader can string-match
    expect(opened).toEqual(["ws://browser:9222/page/1"]);
  });

  it("throws UpstreamError when the evaluation returns no value", async () => {
    const { connect } = fakeSocket(() => ({ id: 1, result: { result: { type: "undefined" } } }));
    await expect(
      captureCdpDom("http://b:9222", {
        fetch: jsonList([{ type: "page", webSocketDebuggerUrl: "ws://b/p" }]),
        connect,
      }),
    ).rejects.toBeInstanceOf(UpstreamError);
  });
});

describe("pickPageTarget", () => {
  const panel = { type: "page", url: "chrome-extension://abc/sidepanel.html", webSocketDebuggerUrl: "ws://panel" };
  const blank = { type: "page", url: "about:blank", webSocketDebuggerUrl: "ws://blank" };
  const work = { type: "page", url: "https://example.com/", webSocketDebuggerUrl: "ws://work" };
  const worker = { type: "service_worker", url: "chrome-extension://abc/bg.js", webSocketDebuggerUrl: "ws://sw" };

  it("follows the browser's most-recently-active ordering — the session brings its work tab to front", () => {
    expect(pickPageTarget([work, panel, blank])?.webSocketDebuggerUrl).toBe("ws://work");
    expect(pickPageTarget([panel, work])?.webSocketDebuggerUrl).toBe("ws://panel");
  });

  it("never settles on a blank tab while a real page is open", () => {
    // The ordering can put about:blank first, and a recording of a blank tab is silently empty rather than wrong.
    expect(pickPageTarget([blank, work, panel])?.webSocketDebuggerUrl).toBe("ws://work");
    expect(pickPageTarget([blank, panel])?.webSocketDebuggerUrl).toBe("ws://panel");
  });

  it("keeps an extension page as a candidate — the work tab starts out as one", () => {
    // A rule that skipped chrome-extension:// URLs would pick the blank tab at exactly the moment recording
    // starts, because remote mode opens its work tab on an extension page before navigating anywhere.
    const beforeNavigation = {
      type: "page",
      url: "chrome-extension://abc/work.html",
      webSocketDebuggerUrl: "ws://work0",
    };
    expect(pickPageTarget([beforeNavigation, panel, blank])?.webSocketDebuggerUrl).toBe("ws://work0");
  });

  it("falls back through the looser choices rather than finding nothing", () => {
    expect(pickPageTarget([blank])?.webSocketDebuggerUrl).toBe("ws://blank");
    expect(pickPageTarget([worker])?.webSocketDebuggerUrl).toBe("ws://sw");
    expect(pickPageTarget([])).toBeUndefined();
  });
});
