import { UpstreamError } from "@everdict/contracts";
import { type CdpSocket, type CdpTarget, pickPageTarget } from "./capture-cdp.js";
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

// A mouse event to inject (CDP Input.dispatchMouseEvent). x/y are CSS pixels in the viewport. `modifiers` is the
// CDP bitmask (Alt=1, Ctrl=2, Meta=4, Shift=8); `buttons` is the pressed-buttons bitmask (left=1, right=2, middle=4)
// — required for drags (a mouseMoved without it reads as a hover, so text selection/sliders never engage).
export interface MouseInput {
  type: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel";
  x: number;
  y: number;
  button?: "none" | "left" | "middle" | "right";
  buttons?: number;
  clickCount?: number;
  deltaX?: number;
  deltaY?: number;
  modifiers?: number;
}
// A keyboard event (CDP Input.dispatchKeyEvent). keyDown carrying `text` produces the character with the full
// keydown/keypress/input sequence (the Puppeteer model); bare keyDown/keyUp for control keys; `modifiers` as above
// (without it Ctrl+A / Shift+Arrow / every shortcut is dead on arrival).
export interface KeyInput {
  type: "keyDown" | "keyUp" | "char" | "rawKeyDown";
  text?: string;
  key?: string;
  code?: string;
  windowsVirtualKeyCode?: number;
  modifiers?: number;
}

export interface BrowserSessionHandle {
  onFrame(cb: (frame: ScreencastFrame) => void): void;
  onError(cb: (err: Error) => void): void;
  onClose(cb: () => void): void;
  // A navigation that RESOLVED to an error page (DNS, proxy, certificate). The session is alive and the canvas
  // is streaming, so nothing else in the pipe can tell the viewer why the page is empty.
  onNavigationError(cb: (info: { url: string; message: string }) => void): void;
  mouse(input: MouseInput): void;
  key(input: KeyInput): void;
  // Insert a composed string as-is (CDP Input.insertText) — the IME path: a client composes Korean/Japanese/… locally
  // and commits the final text in one shot (per-keystroke char events cannot express composition). Committing while a
  // remote composition (setComposition) is active REPLACES it — never a double insert.
  insertText(text: string): void;
  // Mirror the client's in-progress IME composition remotely (CDP Input.imeSetComposition) so the user sees Hangul
  // forming live in the focused field instead of nothing-until-commit. Best-effort: with no focused editable the
  // command errors and is ignored.
  setComposition(text: string): void;
  // Match the remote viewport to the client canvas (CDP Emulation.setDeviceMetricsOverride) — without this the
  // screencast stays at the browser's launch window size and the canvas scales it (blurry, wrong hit-testing feel).
  setViewport(width: number, height: number): void;
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
  // Same selection as the one-shot captures: in an extension-loaded browser the panel is a page target too, and
  // driving one interactively is even worse than screenshotting it — the operator would be clicking the extension's
  // own UI while believing they were driving the page.
  const wsUrl = pickPageTarget(targets)?.webSocketDebuggerUrl;
  if (!wsUrl) throw new UpstreamError("UPSTREAM_ERROR", undefined, "No CDP page target for an interactive session.");

  const ws = connect(reachableWsUrl(wsUrl, cdpHttpBase));
  const frameCbs: Array<(f: ScreencastFrame) => void> = [];
  const errCbs: Array<(e: Error) => void> = [];
  const closeCbs: Array<() => void> = [];
  const navErrCbs: Array<(info: { url: string; message: string }) => void> = [];
  // At most once: the handle's own close() closes the socket, which echoes back as a `close` event — a caller
  // that tears down on close must not be told twice.
  let notifiedClosed = false;
  const notifyClosed = (): void => {
    if (notifiedClosed) return;
    notifiedClosed = true;
    for (const cb of closeCbs) cb();
  };
  // What a `Page.navigate` was ASKED to load — kept per command id so an error reply can name the URL that
  // failed rather than reporting a bare message about nothing in particular.
  const navigating = new Map<number, string>();
  // A caller may issue commands before the socket has opened; queue until open (Node's WebSocket throws
  // "Sent before connected" otherwise), then flush after the screencast is subscribed.
  let opened = false;
  const backlog: string[] = [];
  let id = 0;
  const send = (method: string, params: Record<string, unknown> = {}): void => {
    id += 1;
    if (method === "Page.navigate" && typeof params.url === "string") navigating.set(id, params.url);
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
    let msg: {
      id?: number;
      result?: { errorText?: string };
      method?: string;
      params?: { data?: string; metadata?: ScreencastMetadata; sessionId?: number };
    };
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return; // ignore non-JSON
    }
    // ── A NAVIGATION THAT RESOLVED TO AN ERROR PAGE (downstream report 5.5) ────────────────────────
    //
    // A live browser landing on a DNS/proxy/certificate failure renders an error page, and the relay streams
    // it faithfully: a blank-looking canvas under a green "live" dot with no statement of what happened. The
    // session IS alive, so the teardown propagation above does not cover it — and the framework had no way to
    // say "session fine, navigation failed", which is the ordinary state on any restricted network. CDP has
    // said so all along: the reply to Page.navigate carries `errorText`.
    if (msg.id !== undefined && navigating.has(msg.id)) {
      const url = navigating.get(msg.id) ?? "";
      navigating.delete(msg.id);
      const errorText = msg.result?.errorText;
      if (errorText) for (const cb of navErrCbs) cb({ url, message: errorText });
      return;
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
  // ── A CLOSED BROWSER IS NEWS, AND IT TRAVELS ─────────────────────────────────────────────────────
  //
  // Only `open`/`message`/`error` were registered, so a FAR-SIDE close reached nobody: the handle's onClose
  // fired only from its own close(). The client treats an open socket as "live" (the canvas sets that state on
  // WS open and never revisits it), so a browser that went away left a green dot over a frozen frame — and
  // with the pooled provisioner, where release RESETS the browser instead of killing it, the socket survives
  // to about:blank and the relay faithfully streams a blank page.
  ws.addEventListener("close", () => notifyClosed());

  return {
    onFrame: (cb) => frameCbs.push(cb),
    onError: (cb) => errCbs.push(cb),
    onClose: (cb) => closeCbs.push(cb),
    onNavigationError: (cb) => navErrCbs.push(cb),
    mouse: (input) => send("Input.dispatchMouseEvent", { ...input }),
    key: (input) => send("Input.dispatchKeyEvent", { ...input }),
    insertText: (text) => send("Input.insertText", { text }),
    setComposition: (text) =>
      send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length }),
    setViewport: (width, height) =>
      send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }),
    navigate: (url) => send("Page.navigate", { url }),
    close: () => {
      try {
        ws.close();
      } catch {
        // best-effort
      }
      notifyClosed();
    },
  };
}
