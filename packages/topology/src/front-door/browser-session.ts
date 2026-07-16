import { UpstreamError } from "@everdict/contracts";
import type { CdpSocket, CdpTarget } from "./capture-cdp.js";
import { reachableWsUrl } from "./cdp-ws.js";

// Interactive live browser session over CDP — the bidirectional sibling of capture-cdp's one-shot screenshot.
// Given a running Chrome DevTools Protocol HTTP base (the same endpoint the topology runtime discovers per case), it
// opens a page target's CDP WebSocket, streams the screen as a continuous screencast (frames OUT), and forwards
// mouse/keyboard/navigation into the real browser (input IN). This is the primitive a real interactive remote browser
// (profile login capture, live eval debugging) is built on. Transport-injectable (fetch/connect) so it is
// unit-testable without a real browser and drives the live path over Node's global WebSocket/fetch.

// CDP Page.screencastFrame metadata — viewport geometry, for mapping canvas coords → CDP input.
export interface ScreencastMetadata {
  offsetTop: number;
  pageScaleFactor: number;
  deviceWidth: number;
  deviceHeight: number;
  scrollOffsetX: number;
  scrollOffsetY: number;
}
export interface ScreencastFrame {
  data: string; // base64 image (format per options; jpeg default)
  metadata: ScreencastMetadata;
}

// A mouse event to inject (CDP Input.dispatchMouseEvent). x/y are CSS pixels in the viewport.
export interface MouseInput {
  type: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel";
  x: number;
  y: number;
  button?: "none" | "left" | "middle" | "right";
  clickCount?: number;
  deltaX?: number;
  deltaY?: number;
}
// A keyboard event (CDP Input.dispatchKeyEvent). "char" + text inserts a character; keyDown/keyUp for control keys.
export interface KeyInput {
  type: "keyDown" | "keyUp" | "char" | "rawKeyDown";
  text?: string;
  key?: string;
  code?: string;
  windowsVirtualKeyCode?: number;
}

export interface BrowserSessionHandle {
  onFrame(cb: (frame: ScreencastFrame) => void): void;
  onError(cb: (err: Error) => void): void;
  onClose(cb: () => void): void;
  mouse(input: MouseInput): void;
  key(input: KeyInput): void;
  navigate(url: string): void;
  close(): void;
}

export interface BrowserSessionOptions {
  fetch?: typeof fetch;
  connect?: (url: string) => CdpSocket; // default: new WebSocket(url) (Node global)
  timeoutMs?: number; // page-target discovery cap (default 10s)
  screencast?: {
    format?: "jpeg" | "png";
    quality?: number;
    maxWidth?: number;
    maxHeight?: number;
    everyNthFrame?: number;
  };
}

// Open an interactive session against a running browser's CDP HTTP base. Returns a handle that streams frames and
// accepts input; throws UpstreamError if no page target is reachable.
export async function openBrowserSession(
  cdpHttpBase: string,
  opts: BrowserSessionOptions = {},
): Promise<BrowserSessionHandle> {
  const fetchImpl = opts.fetch ?? fetch;
  const connect = opts.connect ?? ((url: string) => new WebSocket(url) as unknown as CdpSocket);
  const sc = { format: "jpeg" as const, quality: 60, everyNthFrame: 1, ...opts.screencast };

  const listRes = await fetchImpl(`${cdpHttpBase}/json`);
  if (!listRes.ok) throw new UpstreamError("UPSTREAM_ERROR", { status: listRes.status }, "CDP /json unreachable.");
  const targets = (await listRes.json()) as CdpTarget[];
  const wsUrl = (
    targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl) ?? targets.find((t) => t.webSocketDebuggerUrl)
  )?.webSocketDebuggerUrl;
  if (!wsUrl) throw new UpstreamError("UPSTREAM_ERROR", undefined, "No CDP page target for an interactive session.");

  const ws = connect(reachableWsUrl(wsUrl, cdpHttpBase));
  const frameCbs: Array<(f: ScreencastFrame) => void> = [];
  const errCbs: Array<(e: Error) => void> = [];
  const closeCbs: Array<() => void> = [];
  // A caller may issue commands before the socket has opened; queue until open (Node's WebSocket throws
  // "Sent before connected" otherwise), then flush after the screencast is subscribed.
  let opened = false;
  const backlog: string[] = [];
  let id = 0;
  const send = (method: string, params: Record<string, unknown> = {}): void => {
    id += 1;
    const payload = JSON.stringify({ id, method, params });
    if (opened) ws.send(payload);
    else backlog.push(payload);
  };

  ws.addEventListener("open", () => {
    opened = true;
    send("Page.enable");
    send("Page.startScreencast", {
      format: sc.format,
      quality: sc.quality,
      everyNthFrame: sc.everyNthFrame,
      ...(sc.maxWidth !== undefined ? { maxWidth: sc.maxWidth } : {}),
      ...(sc.maxHeight !== undefined ? { maxHeight: sc.maxHeight } : {}),
    });
    for (const payload of backlog.splice(0)) ws.send(payload);
  });
  ws.addEventListener("message", (ev) => {
    let msg: { method?: string; params?: { data?: string; metadata?: ScreencastMetadata; sessionId?: number } };
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return; // ignore non-JSON
    }
    if (msg.method !== "Page.screencastFrame") return; // command replies / other events are ignored by the session
    const data = msg.params?.data;
    const metadata = msg.params?.metadata;
    const sessionId = msg.params?.sessionId;
    // ACK every frame — CDP stalls the screencast after a couple of frames if a frame is left unacked. Critical.
    if (sessionId !== undefined) send("Page.screencastFrameAck", { sessionId });
    if (typeof data === "string" && metadata) for (const cb of frameCbs) cb({ data, metadata });
  });
  ws.addEventListener("error", () => {
    for (const cb of errCbs) cb(new Error("CDP browser session socket error."));
  });

  return {
    onFrame: (cb) => frameCbs.push(cb),
    onError: (cb) => errCbs.push(cb),
    onClose: (cb) => closeCbs.push(cb),
    mouse: (input) => send("Input.dispatchMouseEvent", { ...input }),
    key: (input) => send("Input.dispatchKeyEvent", { ...input }),
    navigate: (url) => send("Page.navigate", { url }),
    close: () => {
      try {
        ws.close();
      } catch {
        // best-effort
      }
      for (const cb of closeCbs) cb();
    },
  };
}
