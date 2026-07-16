import { UpstreamError } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { CdpSocket } from "./capture-cdp.js";
import { captureStorageState, seedStorageState, storageStateDomains } from "./capture-storage-state.js";

// A fake CDP WebSocket — replays open then a scripted reply to the sent command (mirrors capture-cdp.test).
function fakeSocket(reply: (sent: unknown) => unknown): { connect: (url: string) => CdpSocket; opened: string[] } {
  const opened: string[] = [];
  const connect = (url: string): CdpSocket => {
    opened.push(url);
    const msgHandlers: Array<(ev: { data: unknown }) => void> = [];
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
        else if (type === "open") queueMicrotask(() => cb());
      },
    } as CdpSocket;
    return sock;
  };
  return { connect, opened };
}

const jsonList = (targets: unknown[]) =>
  (async () => new Response(JSON.stringify(targets), { status: 200 })) as unknown as typeof fetch;

describe("captureStorageState", () => {
  it("picks a page target, sends Network.getAllCookies, returns the mapped cookies", async () => {
    const { connect, opened } = fakeSocket((sent) => {
      expect(sent).toMatchObject({ id: 1, method: "Network.getAllCookies" });
      return {
        id: 1,
        result: {
          cookies: [
            {
              name: "sid",
              value: "s",
              domain: ".github.com",
              path: "/",
              httpOnly: true,
              secure: true,
              sameSite: "Lax",
              size: 4,
            },
          ],
        },
      };
    });
    const state = await captureStorageState("http://browser:9222", {
      fetch: jsonList([
        { type: "background_page", webSocketDebuggerUrl: "ws://x/bg" },
        { type: "page", webSocketDebuggerUrl: "ws://browser:9222/page/1" },
      ]),
      connect,
    });
    expect(state.cookies).toEqual([
      { name: "sid", value: "s", domain: ".github.com", path: "/", httpOnly: true, secure: true, sameSite: "Lax" },
    ]);
    expect(opened).toEqual(["ws://browser:9222/page/1"]);
  });

  it("throws when there is no CDP page target", async () => {
    await expect(
      captureStorageState("http://b:9222", {
        fetch: jsonList([{ type: "other" }]),
        connect: fakeSocket(() => ({})).connect,
      }),
    ).rejects.toBeInstanceOf(UpstreamError);
  });

  it("surfaces a CDP protocol error as UpstreamError", async () => {
    const { connect } = fakeSocket(() => ({ id: 1, error: { message: "Target closed" } }));
    await expect(
      captureStorageState("http://b:9222", {
        fetch: jsonList([{ type: "page", webSocketDebuggerUrl: "ws://b/p" }]),
        connect,
      }),
    ).rejects.toThrow(/Target closed/);
  });
});

describe("seedStorageState", () => {
  const STATE = { cookies: [{ name: "sid", value: "s", domain: ".github.com", path: "/" }] };

  it("sends Network.setCookies with the storageState cookies to a page target", async () => {
    let sent: unknown;
    const { connect, opened } = fakeSocket((s) => {
      sent = s;
      return { id: 1, result: {} };
    });
    await seedStorageState("http://browser:9222", STATE, {
      fetch: jsonList([{ type: "page", webSocketDebuggerUrl: "ws://browser:9222/page/1" }]),
      connect,
    });
    expect(sent).toMatchObject({ id: 1, method: "Network.setCookies", params: { cookies: STATE.cookies } });
    expect(opened).toEqual(["ws://browser:9222/page/1"]);
  });

  it("is a no-op for an empty storageState (no CDP call)", async () => {
    let fetched = false;
    const fetchImpl = (async () => {
      fetched = true;
      return new Response("[]");
    }) as unknown as typeof fetch;
    await seedStorageState("http://b:9222", { cookies: [] }, { fetch: fetchImpl });
    expect(fetched).toBe(false);
  });

  it("surfaces a CDP protocol error as UpstreamError", async () => {
    const { connect } = fakeSocket(() => ({ id: 1, error: { message: "Invalid cookie" } }));
    await expect(
      seedStorageState("http://b:9222", STATE, {
        fetch: jsonList([{ type: "page", webSocketDebuggerUrl: "ws://b/p" }]),
        connect,
      }),
    ).rejects.toThrow(/Invalid cookie/);
  });
});

describe("storageStateDomains", () => {
  it("returns unique cookie domains, leading dot stripped, sorted", () => {
    expect(
      storageStateDomains({
        cookies: [
          { name: "a", value: "1", domain: ".github.com", path: "/" },
          { name: "b", value: "2", domain: "github.com", path: "/" },
          { name: "c", value: "3", domain: "app.example.com", path: "/" },
        ],
      }),
    ).toEqual(["app.example.com", "github.com"]);
  });
});
