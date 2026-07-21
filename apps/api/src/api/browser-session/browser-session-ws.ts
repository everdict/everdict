import { type BrowserSessionHandle, openBrowserSession } from "@everdict/topology";
import type { WebSocket } from "ws";
import { z } from "zod";

// The relay half of the interactive browser-session WS (browser-profiles S1). server.ts (the thin composition root)
// authenticates the ticket + resolves the CDP base, then hands the upgraded socket here. This module owns the
// bidirectional pipe: CDP screencast frames OUT (as JSON) + validated mouse/keyboard/navigate input IN.

const OPEN = 1; // ws readyState OPEN (numeric — the instance constant is unreliable across ws versions).

// Frame backpressure high-water mark. Above this many bytes queued on the client socket, screencast frames are
// COALESCED (latest wins) instead of queued — otherwise a client slower than the frame rate accumulates seconds of
// lag and every interaction appears to respond later and later. Input/error messages are never dropped.
const FRAME_HIGH_WATER_BYTES = 256 * 1024;
const FRAME_RETRY_MS = 15;

// Input from the browser canvas — validated at this boundary (untrusted). A discriminated union on `kind`; a
// malformed message is dropped (never a crash). Field sets mirror the CDP Input.dispatch* / Page.navigate params.
const MouseInputSchema = z.object({
  kind: z.literal("mouse"),
  type: z.enum(["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"]),
  x: z.number(),
  y: z.number(),
  button: z.enum(["none", "left", "middle", "right"]).optional(),
  buttons: z.number().int().min(0).max(31).optional(), // pressed-buttons bitmask — carries drags
  clickCount: z.number().optional(),
  deltaX: z.number().optional(),
  deltaY: z.number().optional(),
  modifiers: z.number().int().min(0).max(15).optional(), // CDP bitmask: Alt=1 Ctrl=2 Meta=4 Shift=8
});
const KeyInputSchema = z.object({
  kind: z.literal("key"),
  type: z.enum(["keyDown", "keyUp", "char", "rawKeyDown"]),
  text: z.string().optional(),
  key: z.string().optional(),
  code: z.string().optional(),
  windowsVirtualKeyCode: z.number().optional(),
  modifiers: z.number().int().min(0).max(15).optional(),
});
const NavigateInputSchema = z.object({ kind: z.literal("navigate"), url: z.string() });
// IME path — the client composes locally (Korean/Japanese/…) and commits the final string in one shot.
const InsertTextInputSchema = z.object({ kind: z.literal("insertText"), text: z.string().max(4096) });
// In-progress IME composition, mirrored remotely per keystroke so the user sees Hangul form live.
const ComposeInputSchema = z.object({ kind: z.literal("compose"), text: z.string().max(256) });
// Match the remote viewport to the client canvas. Bounded so a client can't demand an absurd screencast surface.
const ResizeInputSchema = z.object({
  kind: z.literal("resize"),
  width: z.number().int().min(320).max(2560),
  height: z.number().int().min(240).max(1600),
});
export const BrowserSessionInputSchema = z.discriminatedUnion("kind", [
  MouseInputSchema,
  KeyInputSchema,
  NavigateInputSchema,
  InsertTextInputSchema,
  ComposeInputSchema,
  ResizeInputSchema,
]);
export type BrowserSessionInput = z.infer<typeof BrowserSessionInputSchema>;

// Route a validated input message to the CDP session.
function dispatchInput(session: BrowserSessionHandle, input: BrowserSessionInput): void {
  if (input.kind === "mouse") {
    const { kind: _k, ...mouse } = input;
    session.mouse(mouse);
  } else if (input.kind === "key") {
    const { kind: _k, ...key } = input;
    session.key(key);
  } else if (input.kind === "insertText") {
    session.insertText(input.text);
  } else if (input.kind === "compose") {
    session.setComposition(input.text);
  } else if (input.kind === "resize") {
    session.setViewport(input.width, input.height);
  } else {
    session.navigate(input.url);
  }
}

export type OpenSessionFn = typeof openBrowserSession;

// Wire an upgraded WebSocket to a CDP browser session. Opening the session does a CDP discovery fetch + socket
// connect (~hundreds of ms), so early input from the client is buffered and flushed once the session is live —
// exactly the pattern the WS terminal uses. Injectable openSession for unit tests (no real browser).
export function attachBrowserSessionWs(
  ws: WebSocket,
  cdpBase: string,
  openSession: OpenSessionFn = openBrowserSession,
): void {
  const pending: string[] = [];
  let session: BrowserSessionHandle | undefined;
  let closed = false;

  ws.on("message", (data: unknown) => {
    const text = String(data);
    if (session) relay(session, text);
    else pending.push(text);
  });
  ws.on("close", () => {
    closed = true;
    session?.close();
  });

  const relay = (s: BrowserSessionHandle, text: string): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return; // ignore non-JSON
    }
    const input = BrowserSessionInputSchema.safeParse(parsed);
    if (input.success) dispatchInput(s, input.data);
  };

  void (async () => {
    let opened: BrowserSessionHandle;
    try {
      opened = await openSession(cdpBase);
    } catch (err) {
      if (ws.readyState === OPEN) {
        ws.send(JSON.stringify({ type: "error", message: err instanceof Error ? err.message : "session error" }));
        ws.close();
      }
      return;
    }
    if (closed) {
      opened.close(); // the client already went away while we were opening
      return;
    }
    session = opened;
    // Latest-wins frame pump: at most one frame waits behind the socket. When the client can't drain fast enough
    // (slow link/tab), intermediate frames are dropped so what it sees is always the NEWEST state — bounded latency
    // instead of an ever-growing queue.
    let latestFrame: string | undefined;
    let retryTimer: NodeJS.Timeout | undefined;
    const pumpFrame = (): void => {
      retryTimer = undefined;
      if (latestFrame === undefined) return;
      if (ws.readyState !== OPEN) {
        latestFrame = undefined;
        return;
      }
      if (ws.bufferedAmount > FRAME_HIGH_WATER_BYTES) {
        retryTimer = setTimeout(pumpFrame, FRAME_RETRY_MS);
        return;
      }
      ws.send(latestFrame);
      latestFrame = undefined;
    };
    opened.onFrame((frame) => {
      latestFrame = JSON.stringify({ type: "frame", data: frame.data, metadata: frame.metadata });
      if (retryTimer === undefined) pumpFrame();
    });
    opened.onError((err) => {
      if (ws.readyState === OPEN) {
        ws.send(JSON.stringify({ type: "error", message: err.message }));
        ws.close();
      }
    });
    opened.onClose(() => {
      if (ws.readyState === OPEN) ws.close();
    });
    for (const buffered of pending) relay(opened, buffered); // flush what the client sent before the session was ready
    pending.length = 0;
  })();
}
