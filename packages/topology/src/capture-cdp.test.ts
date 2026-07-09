import { UpstreamError } from "@everdict/core";
import { describe, expect, it } from "vitest";
import { type CdpSocket, captureCdpScreenshot } from "./capture-cdp.js";

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
