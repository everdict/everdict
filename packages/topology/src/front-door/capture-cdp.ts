import { UpstreamError } from "@everdict/contracts";
import { reachableWsUrl } from "./cdp-ws.js";

// Live browser observation via CDP (observability ⑦). Given a running Chrome DevTools Protocol HTTP base
// (e.g. http://host:9222 — the same endpoint the topology runtime discovers per case), find a page target and
// capture what a browser benchmark grades on: the rendered DOM (WebArena string_match/program_html, dom-contains)
// and a screenshot PNG (WebVoyager/VLM judging). Reusable + transport-injectable so it's unit-testable without a
// real browser and equally drives the live path (Node's global WebSocket / fetch).
//
// Flow: GET /json → pick a "page" target's webSocketDebuggerUrl → open WS → send one CDP command → extract the reply.

export interface CdpTarget {
  type?: string;
  webSocketDebuggerUrl?: string;
}

// Minimal WS surface (Node 22 global WebSocket satisfies it) — injectable for tests.
export interface CdpSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: "message", cb: (ev: { data: unknown }) => void): void;
  addEventListener(type: "open", cb: () => void): void;
  addEventListener(type: "error", cb: (ev: unknown) => void): void;
}

export interface CaptureCdpOptions {
  fetch?: typeof fetch;
  connect?: (url: string) => CdpSocket; // default: new WebSocket(url) (Node global)
  timeoutMs?: number; // overall cap (default 10s)
}

interface CdpReply {
  id?: number;
  result?: unknown;
  error?: { message?: string };
}

// Open a WS to a page target, send ONE CDP command (id=1), and resolve the value `extract` pulls from the reply.
// Throws UpstreamError on any CDP failure (unreachable /json, no page target, socket error, timeout, CDP error, or
// an empty extraction). Shared by every single-command capture (screenshot, DOM) so the target-selection + socket
// lifecycle lives in one place.
async function cdpCommand<T>(
  cdpHttpBase: string,
  command: { method: string; params?: Record<string, unknown> },
  extract: (reply: CdpReply) => T | undefined,
  what: string,
  opts: CaptureCdpOptions,
): Promise<T> {
  const fetchImpl = opts.fetch ?? fetch;
  const connect = opts.connect ?? ((url: string) => new WebSocket(url) as unknown as CdpSocket);
  const timeoutMs = opts.timeoutMs ?? 10_000;

  const listRes = await fetchImpl(`${cdpHttpBase}/json`);
  if (!listRes.ok) throw new UpstreamError("UPSTREAM_ERROR", { status: listRes.status }, "CDP /json unreachable.");
  const targets = (await listRes.json()) as CdpTarget[];
  const page =
    targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl) ?? targets.find((t) => t.webSocketDebuggerUrl);
  const wsUrl = page?.webSocketDebuggerUrl;
  if (!wsUrl) throw new UpstreamError("UPSTREAM_ERROR", undefined, `No CDP page target to capture ${what}.`);

  return await new Promise<T>((resolve, reject) => {
    const ws = connect(reachableWsUrl(wsUrl, cdpHttpBase));
    const timer = setTimeout(() => {
      ws.close();
      reject(new UpstreamError("UPSTREAM_ERROR", undefined, `CDP ${what} timed out.`));
    }, timeoutMs);
    const done = (fn: () => void): void => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // closing best-effort
      }
      fn();
    };
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id: 1, method: command.method, ...(command.params ? { params: command.params } : {}) }));
    });
    ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as CdpReply;
        if (msg.id !== 1) return; // ignore CDP events; wait for our reply
        if (msg.error)
          return done(() => reject(new UpstreamError("UPSTREAM_ERROR", undefined, msg.error?.message ?? "CDP error")));
        const value = extract(msg);
        if (value === undefined)
          return done(() => reject(new UpstreamError("UPSTREAM_ERROR", undefined, `CDP returned no ${what} data.`)));
        done(() => resolve(value));
      } catch (e) {
        done(() => reject(new UpstreamError("UPSTREAM_ERROR", undefined, e instanceof Error ? e.message : String(e))));
      }
    });
    ws.addEventListener("error", () =>
      done(() => reject(new UpstreamError("UPSTREAM_ERROR", undefined, `CDP ${what} socket error.`))),
    );
  });
}

// Capture the current page as a PNG. Returns raw base64 (no data: prefix), or throws UpstreamError on any CDP failure.
export function captureCdpScreenshot(cdpHttpBase: string, opts: CaptureCdpOptions = {}): Promise<string> {
  return cdpCommand(
    cdpHttpBase,
    { method: "Page.captureScreenshot", params: { format: "png" } },
    (msg) => (msg.result as { data?: string } | undefined)?.data,
    "screenshot",
    opts,
  );
}

// Capture the rendered DOM — the serialized outerHTML of the live document (post-JS, what the user sees). This is the
// primary observation real browser benchmarks grade on (WebArena string_match/program_html over the page, dom-contains,
// WebShop). Returns the HTML string, or throws UpstreamError on any CDP failure. `Runtime.evaluate` needs no domain
// enable, so it's a single round-trip like the screenshot.
export function captureCdpDom(cdpHttpBase: string, opts: CaptureCdpOptions = {}): Promise<string> {
  return cdpCommand(
    cdpHttpBase,
    {
      method: "Runtime.evaluate",
      params: { expression: "document.documentElement.outerHTML", returnByValue: true },
    },
    (msg) => (msg.result as { result?: { value?: string } } | undefined)?.result?.value,
    "DOM",
    opts,
  );
}
