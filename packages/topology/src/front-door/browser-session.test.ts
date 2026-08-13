import { describe, expect, it } from "vitest";
import { openBrowserSession } from "./browser-session.js";
import type { CdpSocket } from "./capture-cdp.js";

// A CdpSocket fake — not `implements CdpSocket` (its addEventListener is a single sig, not the interface's
// per-event overloads); cast at the connect boundary instead. openBrowserSession only ever calls open/message/error.
class FakeSocket {
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  private readonly handlers: Record<string, Array<(ev?: unknown) => void>> = {};
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.closed = true;
  }
  addEventListener(type: string, cb: (ev?: unknown) => void): void {
    this.handlers[type] = [...(this.handlers[type] ?? []), cb];
  }
  emit(type: string, ev?: unknown): void {
    for (const cb of this.handlers[type] ?? []) cb(ev);
  }
  methods(): string[] {
    return this.sent.map((m) => String(m.method));
  }
  byMethod(method: string): Array<Record<string, unknown>> {
    return this.sent.filter((m) => m.method === method);
  }
}

const fakeFetch = (targets: unknown): typeof fetch =>
  (async () => ({ ok: true, json: async () => targets }) as unknown as Response) as unknown as typeof fetch;

const frameEvent = (data: string, sessionId: number): { data: string } => ({
  data: JSON.stringify({
    method: "Page.screencastFrame",
    params: {
      data,
      sessionId,
      metadata: {
        deviceWidth: 800,
        deviceHeight: 600,
        offsetTop: 0,
        pageScaleFactor: 1,
        scrollOffsetX: 0,
        scrollOffsetY: 0,
      },
    },
  }),
});

describe("openBrowserSession (interactive CDP: screencast out + input in)", () => {
  const setup = async (): Promise<{ sock: FakeSocket; handle: Awaited<ReturnType<typeof openBrowserSession>> }> => {
    const sock = new FakeSocket();
    const handle = await openBrowserSession("http://b:9222", {
      fetch: fakeFetch([{ type: "page", webSocketDebuggerUrl: "ws://b/page" }]),
      connect: () => sock as unknown as CdpSocket,
    });
    return { sock, handle };
  };

  it("subscribes to the screencast on open (Page.enable + Page.startScreencast)", async () => {
    const { sock } = await setup();
    sock.emit("open");
    expect(sock.methods()).toEqual(expect.arrayContaining(["Page.enable", "Page.startScreencast"]));
  });

  it("emits each screencast frame AND acks it — an unacked frame stalls the CDP stream", async () => {
    const { sock, handle } = await setup();
    sock.emit("open");
    const frames: string[] = [];
    handle.onFrame((f) => frames.push(f.data));
    sock.emit("message", frameEvent("AAAA", 7));
    expect(frames).toEqual(["AAAA"]);
    const acks = sock.byMethod("Page.screencastFrameAck");
    expect(acks).toHaveLength(1);
    expect((acks[0]?.params as { sessionId?: number }).sessionId).toBe(7);
  });

  it("forwards mouse, keyboard, and navigation as CDP Input/Page commands", async () => {
    const { sock, handle } = await setup();
    sock.emit("open");
    handle.mouse({ type: "mousePressed", x: 12, y: 34, button: "left", clickCount: 1 });
    handle.key({ type: "char", text: "a" });
    handle.navigate("https://example.com/login");
    expect(sock.byMethod("Input.dispatchMouseEvent")[0]?.params).toMatchObject({
      type: "mousePressed",
      x: 12,
      y: 34,
      button: "left",
    });
    expect(sock.byMethod("Input.dispatchKeyEvent")[0]?.params).toMatchObject({ type: "char", text: "a" });
    expect(sock.byMethod("Page.navigate")[0]?.params).toMatchObject({ url: "https://example.com/login" });
  });

  it("commits composed IME text in one shot via Input.insertText", async () => {
    const { sock, handle } = await setup();
    sock.emit("open");
    handle.insertText("안녕하세요");
    expect(sock.byMethod("Input.insertText")[0]?.params).toMatchObject({ text: "안녕하세요" });
  });

  it("mirrors an in-progress composition via Input.imeSetComposition with the caret at the end", async () => {
    const { sock, handle } = await setup();
    sock.emit("open");
    handle.setComposition("안녕");
    expect(sock.byMethod("Input.imeSetComposition")[0]?.params).toMatchObject({
      text: "안녕",
      selectionStart: 2,
      selectionEnd: 2,
    });
  });

  it("matches the remote viewport to the client canvas via Emulation.setDeviceMetricsOverride", async () => {
    const { sock, handle } = await setup();
    sock.emit("open");
    handle.setViewport(1440, 900);
    expect(sock.byMethod("Emulation.setDeviceMetricsOverride")[0]?.params).toMatchObject({
      width: 1440,
      height: 900,
      mobile: false,
    });
  });

  it("throws when there is no CDP page target", async () => {
    await expect(
      openBrowserSession("http://b:9222", {
        fetch: fakeFetch([]),
        connect: () => new FakeSocket() as unknown as CdpSocket,
      }),
    ).rejects.toThrow(/no cdp page target/i);
  });
});

// ── THE FAR SIDE GOING AWAY, AND A PAGE THAT NEVER LOADED (downstream report 5.3 / 5.5) ──────────────
describe("openBrowserSession — what the viewer is told when the picture stops meaning anything", () => {
  const TARGETS = [{ type: "page", url: "https://x/", webSocketDebuggerUrl: "ws://b/devtools/page/1" }];

  async function session() {
    const socket = new FakeSocket();
    const handle = await openBrowserSession("http://b:9222", {
      fetch: fakeFetch(TARGETS),
      connect: () => socket as unknown as CdpSocket,
    });
    socket.emit("open");
    return { socket, handle };
  }

  it("propagates a far-side close — an open relay socket over a dead browser is a green dot on a frozen frame", async () => {
    const { socket, handle } = await session();
    let closes = 0;
    handle.onClose(() => {
      closes += 1;
    });
    socket.emit("close");
    expect(closes).toBe(1);
  });

  it("tells the caller ONCE — close() echoes back through the socket, and twice is a lie about two events", async () => {
    const { socket, handle } = await session();
    let closes = 0;
    handle.onClose(() => {
      closes += 1;
    });
    handle.close();
    socket.emit("close"); // the real socket's own close event, arriving after our close()
    expect(closes).toBe(1);
  });

  it("names a navigation that RESOLVED to an error page — the session is alive, the page is not", async () => {
    const { socket, handle } = await session();
    const failures: Array<{ url: string; message: string }> = [];
    handle.onNavigationError((info) => failures.push(info));
    handle.navigate("https://intranet.corp/login");
    const navigate = socket.sent.find((m) => m.method === "Page.navigate");
    socket.emit("message", {
      data: JSON.stringify({ id: navigate?.id, result: { errorText: "net::ERR_NAME_NOT_RESOLVED" } }),
    });
    // Without this the canvas shows Chrome's error page and says nothing: on a restricted network that is the
    // ordinary outcome, and it is indistinguishable from an agent that did nothing.
    expect(failures).toEqual([{ url: "https://intranet.corp/login", message: "net::ERR_NAME_NOT_RESOLVED" }]);
  });

  it("says nothing when the navigation succeeded", async () => {
    const { socket, handle } = await session();
    const failures: unknown[] = [];
    handle.onNavigationError((info) => failures.push(info));
    handle.navigate("https://ok.example/");
    const navigate = socket.sent.find((m) => m.method === "Page.navigate");
    socket.emit("message", { data: JSON.stringify({ id: navigate?.id, result: { frameId: "f1" } }) });
    expect(failures).toEqual([]);
  });
});
