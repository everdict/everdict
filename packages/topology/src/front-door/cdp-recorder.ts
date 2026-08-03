import type { TrackEntry } from "@everdict/contracts";
import { type CdpSocket, type CdpTarget, pickPageTarget } from "./capture-cdp.js";
import { reachableWsUrl } from "./cdp-ws.js";

// Environment-plane recorder for a CDP browser target (replay ②). The bidirectional sibling of capture-cdp's one-shot
// DOM/screenshot: instead of one command→reply, it holds a persistent CDP WebSocket for the whole case and SUBSCRIBES to
// the browser's own event stream — Network requests, console messages, navigations (+ optional screencast frames) — so a
// browser-use replay shows HOW THE PAGE CHANGED underneath the agent, not just the agent's decisions. This is the "capture
// the environment at its own layer, independently of the agent" the design calls for (docs/architecture/replay.md,
// Principles 2/3 + D5). Transport-injectable (fetch/connect) so it is unit-testable without a real browser and drives the
// live path over Node's global WebSocket/fetch. Best-effort throughout — a recorder failure must NEVER affect the run.

// The sink the recorder appends to — the environment-plane twin of the frame/log tees (CaseRecorder / report_case_*).
// `track` carries the cheap text lanes (network/console/nav) as a prepared TrackEntry (pure append downstream); `frame`
// carries a raw screencast frame (base64 PNG) that the downstream (recordFrame / report_case_screen) OFFLOADS + stamps —
// so the recorder never offloads bytes itself. Both best-effort: a sink throw is swallowed at the call site.
export interface EnvRecordSink {
  track(item: TrackEntry): void;
  frame?(frameBase64: string): void;
}

export interface CdpEnvironmentRecorderOptions {
  fetch?: typeof fetch;
  connect?: (url: string) => CdpSocket; // default: new WebSocket(url) (Node global)
  now?: () => number; // wall clock — track.t must share the agent trace's epoch clock (D1) so the player aligns them. Default Date.now.
  frames?: boolean; // also stream screencast frames through sink.frame (default false — the text lanes are cheap; frames offload downstream)
  frameThrottleMs?: number; // min gap between EMITTED frames (default 1000ms) — bounds screencast offload volume
  // How long start() waits for the subscriptions to be acknowledged before letting the case proceed unrecorded
  // (default 5s). A cap, not a target: a browser that never answers must not hold an eval behind a recording.
  subscribeTimeoutMs?: number;
  timeoutMs?: number; // page-target discovery cap (default 10s)
}

// A RemoteObject preview for the console lane — the committed value for primitives, else the engine's description
// (objects/errors), bounded so a huge object never bloats the recording. Never throws.
function previewRemoteObject(arg: unknown): string {
  if (arg === null || typeof arg !== "object") return String(arg);
  const o = arg as { value?: unknown; description?: string; type?: string; unserializableValue?: string };
  const raw =
    o.value !== undefined
      ? typeof o.value === "string"
        ? o.value
        : JSON.stringify(o.value)
      : (o.description ?? o.unserializableValue ?? o.type ?? "");
  return raw.length > 2000 ? `${raw.slice(0, 2000)}…` : raw;
}

export class CdpEnvironmentRecorder {
  private ws: CdpSocket | undefined;
  private started = false;
  private stopped = false;
  private opened = false;
  private commandId = 0;
  private readonly backlog: string[] = [];
  // Requests in flight (requestId → its start + coordinates + status), completed on loadingFinished/Failed.
  private readonly pending = new Map<string, { t: number; method: string; url: string; status?: number }>();
  private lastNavUrl: string | undefined;
  private lastFrameAt = Number.NEGATIVE_INFINITY; // so the FIRST frame always emits (0 - 0 would otherwise be throttled)
  private onSubscribed: (() => void) | undefined;
  private pendingSubscribeId: number | undefined;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly connect: (url: string) => CdpSocket;

  constructor(
    private readonly cdpHttpBase: string,
    private readonly sink: EnvRecordSink,
    private readonly opts: CdpEnvironmentRecorderOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.fetchImpl = opts.fetch ?? fetch;
    this.connect = opts.connect ?? ((url: string) => new WebSocket(url) as unknown as CdpSocket);
  }

  // Discover a page target, open its CDP WebSocket, and subscribe to the environment event domains. Resolves once the
  // socket is created (events then flow until stop()). Throws only if no page target is reachable (the caller
  // best-effort-catches — a browser without a live page just means an empty environment plane, never a failed run).
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const listRes = await this.fetchImpl(`${this.cdpHttpBase}/json`);
    if (!listRes.ok) throw new Error(`CDP /json unreachable (${listRes.status}).`);
    const targets = (await listRes.json()) as CdpTarget[];
    // Same selection as the captures: recording the extension's panel would fill the replay's network and console
    // lanes with the extension's own traffic instead of the page the case acted on.
    const wsUrl = pickPageTarget(targets)?.webSocketDebuggerUrl;
    if (!wsUrl) throw new Error("No CDP page target to record.");
    if (this.stopped) return; // stop() raced start() — don't open a socket we'll never close

    const ws = this.connect(reachableWsUrl(wsUrl, this.cdpHttpBase));
    this.ws = ws;
    // Returning as soon as the socket object exists made recording a race the CASE could win: the caller starts the
    // agent immediately, and a page that loads in a few hundred milliseconds is over before Network.enable is even
    // sent. The result was the worst shape of failure — long cases recorded fine while short ones came back with an
    // empty replay and no error anywhere. So start() resolves only once the subscriptions are acknowledged.
    const subscribed = new Promise<void>((resolve) => {
      this.onSubscribed = resolve;
    });
    ws.addEventListener("open", () => {
      this.opened = true;
      // Subscribe to the environment domains. Network/Runtime/Page.enable start the event streams; screencast is opt-in.
      this.send("Network.enable");
      this.send("Runtime.enable");
      this.send("Page.enable");
      if (this.opts.frames) this.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
      this.pendingSubscribeId = this.commandId; // the last enable — its reply means the stream is live
      for (const payload of this.backlog.splice(0)) ws.send(payload);
    });
    ws.addEventListener("message", (ev) => this.onMessage(ev.data));
    ws.addEventListener("error", () => {
      // Socket error — stop recording silently (the run continues; the recording is best-effort).
      this.stop();
      this.settleSubscribed();
    });
    // Bounded: a browser that never acknowledges must not hold the case behind an observability concern.
    await Promise.race([subscribed, this.delay(this.opts.subscribeTimeoutMs ?? 5_000)]);
  }

  // Resolve start()'s wait exactly once, whether the subscriptions landed, the socket died, or we gave up.
  private settleSubscribed(): void {
    const resolve = this.onSubscribed;
    this.onSubscribed = undefined;
    resolve?.();
  }

  private delay(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      // Never keep a process alive for a recording that has already given up.
      (timer as unknown as { unref?: () => void }).unref?.();
    });
  }

  // Close the socket. Idempotent — called from dispatch's finally and on socket error.
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    try {
      this.ws?.close();
    } catch {
      // best-effort
    }
  }

  private send(method: string, params: Record<string, unknown> = {}): void {
    this.commandId += 1;
    const payload = JSON.stringify({ id: this.commandId, method, params });
    if (this.opened && this.ws) this.ws.send(payload);
    else this.backlog.push(payload);
  }

  private emitTrack(item: TrackEntry): void {
    try {
      this.sink.track(item);
    } catch {
      // best-effort — a sink failure must never affect the run
    }
  }

  private onMessage(data: unknown): void {
    if (this.stopped) return;
    let msg: { id?: number; method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(String(data)) as typeof msg;
    } catch {
      return; // non-JSON
    }
    const method = msg.method;
    if (!method) {
      // A command reply. The only one that matters is the last enable's: it is the moment the event stream is
      // actually live, which is what start() waits for.
      if (msg.id !== undefined && this.pendingSubscribeId !== undefined && msg.id >= this.pendingSubscribeId) {
        this.settleSubscribed();
      }
      return;
    }
    const params = msg.params ?? {};
    try {
      switch (method) {
        case "Network.requestWillBeSent":
          this.onRequest(params);
          break;
        case "Network.responseReceived":
          this.onResponse(params);
          break;
        case "Network.loadingFinished":
        case "Network.loadingFailed":
          this.onLoadingDone(params);
          break;
        case "Runtime.consoleAPICalled":
          this.onConsole(params);
          break;
        case "Runtime.exceptionThrown":
          this.onException(params);
          break;
        case "Page.frameNavigated":
          this.onNavigated(params);
          break;
        case "Page.screencastFrame":
          this.onScreencastFrame(params);
          break;
        default:
          break; // an event we don't record
      }
    } catch {
      // a malformed event never breaks the recorder
    }
  }

  private onRequest(params: Record<string, unknown>): void {
    const requestId = params.requestId;
    const request = params.request as { method?: string; url?: string } | undefined;
    if (typeof requestId !== "string" || !request?.url) return;
    // Bound in-flight tracking so a page that opens requests it never finishes (long-poll/SSE) can't leak unboundedly.
    if (this.pending.size > 2000) {
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) this.pending.delete(oldest);
    }
    this.pending.set(requestId, { t: this.now(), method: request.method ?? "GET", url: request.url });
  }

  private onResponse(params: Record<string, unknown>): void {
    const requestId = params.requestId;
    const response = params.response as { status?: number } | undefined;
    if (typeof requestId !== "string") return;
    const entry = this.pending.get(requestId);
    if (entry && typeof response?.status === "number") entry.status = response.status;
  }

  private onLoadingDone(params: Record<string, unknown>): void {
    const requestId = params.requestId;
    if (typeof requestId !== "string") return;
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);
    // t = when the request FIRED (so it lands on the timeline where the agent triggered it); ms = its duration.
    this.emitTrack({
      track: "network",
      entry: {
        t: entry.t,
        method: entry.method,
        url: entry.url,
        ...(entry.status !== undefined ? { status: entry.status } : {}),
        ms: Math.max(0, this.now() - entry.t),
      },
    });
  }

  private onConsole(params: Record<string, unknown>): void {
    const level = typeof params.type === "string" ? params.type : "log";
    const args = Array.isArray(params.args) ? params.args : [];
    const text = args.map(previewRemoteObject).join(" ");
    this.emitTrack({ track: "console", entry: { t: this.now(), level, text } });
  }

  private onException(params: Record<string, unknown>): void {
    const details = params.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
    const text = details?.exception?.description ?? details?.text ?? "Uncaught exception";
    this.emitTrack({ track: "console", entry: { t: this.now(), level: "error", text } });
  }

  private onNavigated(params: Record<string, unknown>): void {
    const frame = params.frame as { url?: string; parentId?: string } | undefined;
    // Main-frame navigations only (sub-frames/iframes are noise for the URL history).
    if (!frame?.url || frame.parentId) return;
    if (frame.url === this.lastNavUrl) return; // dedup consecutive identical navigations
    this.lastNavUrl = frame.url;
    this.emitTrack({ track: "nav", entry: { t: this.now(), url: frame.url } });
  }

  private onScreencastFrame(params: Record<string, unknown>): void {
    const sessionId = params.sessionId;
    // ACK every frame — CDP stalls the screencast after a couple of frames if a frame is left unacked. Critical.
    if (typeof sessionId === "number") this.send("Page.screencastFrameAck", { sessionId });
    const data = params.data;
    if (typeof data !== "string" || !this.sink.frame) return;
    // Throttle EMITTED frames — the screencast fires on every visual change; the recording only needs a bounded cadence
    // (consecutive-identical frames are additionally hash-deduped when offloaded downstream).
    const throttle = this.opts.frameThrottleMs ?? 1000;
    const now = this.now();
    if (now - this.lastFrameAt < throttle) return;
    this.lastFrameAt = now;
    try {
      this.sink.frame(data);
    } catch {
      // best-effort
    }
  }
}
