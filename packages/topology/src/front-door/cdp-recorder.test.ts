import type { TrackEntry } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { CdpSocket } from "./capture-cdp.js";
import { CdpEnvironmentRecorder, type EnvRecordSink } from "./cdp-recorder.js";

// A CdpSocket fake — mirrors browser-session.test's fake (single-sig addEventListener, cast at connect boundary).
class FakeSocket {
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  // A browser that accepts commands but never answers — the recorder must not wait on it forever.
  silent = false;
  private readonly handlers: Record<string, Array<(ev?: unknown) => void>> = {};
  send(data: string): void {
    const message = JSON.parse(data) as { id?: number };
    this.sent.push(message);
    // Real CDP replies to every command with its id. The fake used to stay silent, which is exactly the fiction
    // that let a recorder ship believing it was subscribed when it was not.
    if (message.id !== undefined && !this.silent)
      queueMicrotask(() => this.emit("message", { data: JSON.stringify({ id: message.id }) }));
  }
  close(): void {
    this.closed = true;
  }
  addEventListener(type: string, cb: (ev?: unknown) => void): void {
    this.handlers[type] = [...(this.handlers[type] ?? []), cb];
    // A real socket connects on its own; the recorder subscribes when it opens. Self-timing here keeps the tests
    // from having to guess when the recorder is ready to hear it.
    if (type === "open") queueMicrotask(() => cb());
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
  (async () =>
    ({ ok: true, status: 200, json: async () => targets }) as unknown as Response) as unknown as typeof fetch;

const msg = (method: string, params: Record<string, unknown>): { data: string } => ({
  data: JSON.stringify({ method, params }),
});

// A collecting sink + a monotonic clock, so track.t / ms are deterministic.
function setup(opts?: { frames?: boolean; now?: () => number }): {
  sock: FakeSocket;
  tracks: TrackEntry[];
  frames: string[];
  recorder: CdpEnvironmentRecorder;
  start: () => Promise<void>;
} {
  const sock = new FakeSocket();
  const tracks: TrackEntry[] = [];
  const frames: string[] = [];
  const sink: EnvRecordSink = { track: (item) => tracks.push(item), frame: (f) => frames.push(f) };
  const recorder = new CdpEnvironmentRecorder("http://b:9222", sink, {
    fetch: fakeFetch([{ type: "page", webSocketDebuggerUrl: "ws://b/page" }]),
    connect: () => sock as unknown as CdpSocket,
    ...(opts?.frames !== undefined ? { frames: opts.frames } : {}),
    ...(opts?.now ? { now: opts.now } : {}),
  });
  // start() now resolves only once the subscriptions are acknowledged — the socket opens and acks on its own.
  return { sock, tracks, frames, recorder, start: () => recorder.start() };
}

describe("CdpEnvironmentRecorder (environment plane: browser CDP event stream → replay tracks)", () => {
  it("subscribes to the environment domains on open (Network/Runtime/Page.enable)", async () => {
    const { sock, start } = setup();
    await start();
    expect(sock.methods()).toEqual(expect.arrayContaining(["Network.enable", "Runtime.enable", "Page.enable"]));
    // Screencast is opt-in — not enabled by default (the text lanes are the cheap default).
    expect(sock.methods()).not.toContain("Page.startScreencast");
  });

  it("records a completed request as a network track (method · url · status · duration)", async () => {
    let clock = 1000;
    const { sock, tracks, start } = setup({ now: () => clock });
    await start();
    sock.emit(
      "message",
      msg("Network.requestWillBeSent", { requestId: "r1", request: { method: "GET", url: "https://x/a" } }),
    );
    clock = 1100;
    sock.emit("message", msg("Network.responseReceived", { requestId: "r1", response: { status: 200 } }));
    clock = 1150;
    sock.emit("message", msg("Network.loadingFinished", { requestId: "r1" }));
    expect(tracks).toEqual([
      { track: "network", entry: { t: 1000, method: "GET", url: "https://x/a", status: 200, ms: 150 } },
    ]);
  });

  it("records a console message as a console track with its level and joined args", async () => {
    let clock = 5;
    const { sock, tracks, start } = setup({ now: () => clock });
    await start();
    clock = 42;
    sock.emit(
      "message",
      msg("Runtime.consoleAPICalled", {
        type: "error",
        args: [
          { type: "string", value: "boom" },
          { type: "number", value: 7 },
        ],
      }),
    );
    expect(tracks).toEqual([{ track: "console", entry: { t: 42, level: "error", text: "boom 7" } }]);
  });

  it("records a main-frame navigation as a nav track, ignoring sub-frames and consecutive duplicates", async () => {
    const { sock, tracks, start } = setup({ now: () => 1 });
    await start();
    sock.emit("message", msg("Page.frameNavigated", { frame: { url: "https://x/home" } }));
    sock.emit("message", msg("Page.frameNavigated", { frame: { url: "https://ad/iframe", parentId: "f0" } })); // sub-frame → ignored
    sock.emit("message", msg("Page.frameNavigated", { frame: { url: "https://x/home" } })); // dup → ignored
    sock.emit("message", msg("Page.frameNavigated", { frame: { url: "https://x/next" } }));
    expect(tracks).toEqual([
      { track: "nav", entry: { t: 1, url: "https://x/home" } },
      { track: "nav", entry: { t: 1, url: "https://x/next" } },
    ]);
  });

  it("acks every screencast frame (an unacked frame stalls CDP) and emits it through the frame sink", async () => {
    let clock = 0;
    const { sock, frames, start } = setup({ frames: true, now: () => clock });
    await start();
    expect(sock.methods()).toContain("Page.startScreencast");
    sock.emit("message", msg("Page.screencastFrame", { data: "AAAA", sessionId: 3 }));
    clock = 2000; // past the 1s throttle
    sock.emit("message", msg("Page.screencastFrame", { data: "BBBB", sessionId: 4 }));
    expect(frames).toEqual(["AAAA", "BBBB"]);
    expect(sock.byMethod("Page.screencastFrameAck").map((m) => (m.params as { sessionId: number }).sessionId)).toEqual([
      3, 4,
    ]);
  });

  it("throttles emitted frames so a chatty screencast does not flood the recording", async () => {
    let clock = 0;
    const { sock, frames, start } = setup({ frames: true, now: () => clock });
    await start();
    sock.emit("message", msg("Page.screencastFrame", { data: "A", sessionId: 1 }));
    clock = 200; // within the 1s throttle → acked but not emitted
    sock.emit("message", msg("Page.screencastFrame", { data: "B", sessionId: 2 }));
    expect(frames).toEqual(["A"]);
    // Both frames are still ACKed (dropping an ack would stall the stream), only the emit is throttled.
    expect(sock.byMethod("Page.screencastFrameAck")).toHaveLength(2);
  });

  it("is best-effort — a throwing track sink never propagates out of the recorder", async () => {
    const sock = new FakeSocket();
    const recorder = new CdpEnvironmentRecorder(
      "http://b:9222",
      {
        track: () => {
          throw new Error("sink down");
        },
      },
      {
        fetch: fakeFetch([{ type: "page", webSocketDebuggerUrl: "ws://b/page" }]),
        connect: () => sock as unknown as CdpSocket,
      },
    );
    await recorder.start();
    expect(() => sock.emit("message", msg("Page.frameNavigated", { frame: { url: "https://x" } }))).not.toThrow();
  });

  it("throws on start when the browser exposes no page target (the caller best-effort-catches)", async () => {
    const recorder = new CdpEnvironmentRecorder(
      "http://b:9222",
      { track: () => {} },
      { fetch: fakeFetch([]), connect: () => new FakeSocket() as unknown as CdpSocket },
    );
    await expect(recorder.start()).rejects.toThrow(/no cdp page target/i);
  });
});

describe("CdpEnvironmentRecorder — start() waits for the subscription to be live", () => {
  it("does not resolve until the enables are acknowledged, so a fast case cannot outrun the recording", async () => {
    // The defect this covers: start() used to resolve as soon as the socket OBJECT existed. The caller then let the
    // agent go, and a page that loaded in a few hundred ms was over before Network.enable was even sent — long
    // cases recorded fine while short ones produced an empty replay with no error anywhere.
    const sock = new FakeSocket();
    const recorder = new CdpEnvironmentRecorder(
      "http://b:9222",
      { track: () => {} },
      {
        fetch: fakeFetch([{ type: "page", webSocketDebuggerUrl: "ws://b/page" }]),
        connect: () => sock as unknown as CdpSocket,
        subscribeTimeoutMs: 5_000,
      },
    );

    const began = Date.now();
    await recorder.start();

    // Resolved via the acknowledgement (fast), not by falling through the timeout.
    expect(Date.now() - began).toBeLessThan(1_000);
    expect(sock.methods()).toEqual(expect.arrayContaining(["Network.enable", "Runtime.enable", "Page.enable"]));
  });

  it("gives up on a browser that never acknowledges rather than holding the case", async () => {
    const sock = new FakeSocket();
    sock.silent = true;
    const recorder = new CdpEnvironmentRecorder(
      "http://b:9222",
      { track: () => {} },
      {
        fetch: fakeFetch([{ type: "page", webSocketDebuggerUrl: "ws://b/page" }]),
        connect: () => sock as unknown as CdpSocket,
        subscribeTimeoutMs: 20,
      },
    );

    // Bounded: an eval must never be held behind an observability concern.
    await expect(recorder.start()).resolves.toBeUndefined();
  });
});
