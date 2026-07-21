import type { BrowserSessionHandle, ScreencastFrame } from "@everdict/topology";
import { describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { attachBrowserSessionWs } from "./browser-session-ws.js";

// A minimal fake WebSocket exposing only the surface attachBrowserSessionWs touches.
class FakeWs {
  readyState = 1; // OPEN
  readonly sent: string[] = [];
  closed = false;
  private handlers: Record<string, ((data?: unknown) => void)[]> = {};
  on(event: string, cb: (data?: unknown) => void): this {
    const list = this.handlers[event] ?? [];
    list.push(cb);
    this.handlers[event] = list;
    return this;
  }
  emit(event: string, data?: unknown): void {
    for (const cb of this.handlers[event] ?? []) cb(data);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
}

// A fake CDP session handle with triggers for the outbound callbacks.
class FakeSession implements BrowserSessionHandle {
  readonly mice: unknown[] = [];
  readonly keys: unknown[] = [];
  readonly navigations: string[] = [];
  readonly insertedTexts: string[] = [];
  readonly viewports: Array<{ width: number; height: number }> = [];
  closed = false;
  private frameCb?: (f: ScreencastFrame) => void;
  private errCb?: (e: Error) => void;
  private closeCb?: () => void;
  onFrame(cb: (f: ScreencastFrame) => void): void {
    this.frameCb = cb;
  }
  onError(cb: (e: Error) => void): void {
    this.errCb = cb;
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }
  mouse(input: unknown): void {
    this.mice.push(input);
  }
  key(input: unknown): void {
    this.keys.push(input);
  }
  navigate(url: string): void {
    this.navigations.push(url);
  }
  insertText(text: string): void {
    this.insertedTexts.push(text);
  }
  setViewport(width: number, height: number): void {
    this.viewports.push({ width, height });
  }
  close(): void {
    this.closed = true;
  }
  emitFrame(f: ScreencastFrame): void {
    this.frameCb?.(f);
  }
  emitError(e: Error): void {
    this.errCb?.(e);
  }
  emitClose(): void {
    this.closeCb?.();
  }
}

const FRAME: ScreencastFrame = {
  data: "AAAA",
  metadata: {
    offsetTop: 0,
    pageScaleFactor: 1,
    deviceWidth: 800,
    deviceHeight: 600,
    scrollOffsetX: 0,
    scrollOffsetY: 0,
  },
};

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("attachBrowserSessionWs", () => {
  it("relays CDP screencast frames OUT as JSON", async () => {
    const ws = new FakeWs();
    const session = new FakeSession();
    attachBrowserSessionWs(ws as unknown as WebSocket, "http://cdp", async () => session);
    await flush();
    session.emitFrame(FRAME);
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0] ?? "{}")).toMatchObject({ type: "frame", data: "AAAA" });
  });

  it("routes validated mouse/key/navigate input IN to the session", async () => {
    const ws = new FakeWs();
    const session = new FakeSession();
    attachBrowserSessionWs(ws as unknown as WebSocket, "http://cdp", async () => session);
    await flush();
    ws.emit("message", JSON.stringify({ kind: "mouse", type: "mousePressed", x: 10, y: 20, button: "left" }));
    ws.emit("message", JSON.stringify({ kind: "key", type: "char", text: "a" }));
    ws.emit("message", JSON.stringify({ kind: "navigate", url: "https://example.com" }));
    expect(session.mice).toEqual([{ type: "mousePressed", x: 10, y: 20, button: "left" }]);
    expect(session.keys).toEqual([{ type: "char", text: "a" }]);
    expect(session.navigations).toEqual(["https://example.com"]);
  });

  it("routes IME insertText and canvas resize input IN to the session", async () => {
    const ws = new FakeWs();
    const session = new FakeSession();
    attachBrowserSessionWs(ws as unknown as WebSocket, "http://cdp", async () => session);
    await flush();
    ws.emit("message", JSON.stringify({ kind: "insertText", text: "안녕하세요" }));
    ws.emit("message", JSON.stringify({ kind: "resize", width: 1440, height: 900 }));
    expect(session.insertedTexts).toEqual(["안녕하세요"]);
    expect(session.viewports).toEqual([{ width: 1440, height: 900 }]);
  });

  it("rejects an out-of-bounds resize (a client cannot demand an absurd screencast surface)", async () => {
    const ws = new FakeWs();
    const session = new FakeSession();
    attachBrowserSessionWs(ws as unknown as WebSocket, "http://cdp", async () => session);
    await flush();
    ws.emit("message", JSON.stringify({ kind: "resize", width: 20_000, height: 900 }));
    ws.emit("message", JSON.stringify({ kind: "resize", width: 1024.5, height: 768 })); // non-integer
    expect(session.viewports).toHaveLength(0);
  });

  it("drops malformed input (bad JSON / unknown kind / missing fields) without crashing", async () => {
    const ws = new FakeWs();
    const session = new FakeSession();
    attachBrowserSessionWs(ws as unknown as WebSocket, "http://cdp", async () => session);
    await flush();
    ws.emit("message", "not json");
    ws.emit("message", JSON.stringify({ kind: "explode" }));
    ws.emit("message", JSON.stringify({ kind: "mouse", type: "mousePressed" })); // missing x/y
    expect(session.mice).toHaveLength(0);
    expect(session.keys).toHaveLength(0);
    expect(session.navigations).toHaveLength(0);
  });

  it("buffers input sent before the session opens and flushes it once live", async () => {
    const ws = new FakeWs();
    const session = new FakeSession();
    let resolveOpen: (s: BrowserSessionHandle) => void = () => undefined;
    const openLater = new Promise<BrowserSessionHandle>((res) => {
      resolveOpen = res;
    });
    attachBrowserSessionWs(ws as unknown as WebSocket, "http://cdp", () => openLater);
    // input arrives while the session is still opening
    ws.emit("message", JSON.stringify({ kind: "navigate", url: "https://early.example" }));
    expect(session.navigations).toHaveLength(0);
    resolveOpen(session);
    await flush();
    expect(session.navigations).toEqual(["https://early.example"]); // flushed after open
  });

  it("reports an open failure on the socket and closes it", async () => {
    const ws = new FakeWs();
    attachBrowserSessionWs(ws as unknown as WebSocket, "http://cdp", async () => {
      throw new Error("no page target");
    });
    await flush();
    expect(ws.closed).toBe(true);
    expect(JSON.parse(ws.sent[0] ?? "{}")).toMatchObject({ type: "error", message: "no page target" });
  });

  it("closes the CDP session when the client socket closes", async () => {
    const ws = new FakeWs();
    const session = new FakeSession();
    attachBrowserSessionWs(ws as unknown as WebSocket, "http://cdp", async () => session);
    await flush();
    ws.emit("close");
    expect(session.closed).toBe(true);
  });
});
