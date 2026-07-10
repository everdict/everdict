import { UpstreamError } from "@everdict/contracts";

// Live browser frame via CDP (observability ⑦). Given a running Chrome DevTools Protocol HTTP base
// (e.g. http://host:9222 — the same endpoint the topology runtime discovers per case), find a page
// target and capture its current screen as a PNG. Reusable + transport-injectable so it's unit-testable
// without a real browser and equally drives the live path (Node's global WebSocket / fetch).
//
// Flow: GET /json → pick a "page" target's webSocketDebuggerUrl → open WS → Page.captureScreenshot → base64.

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

// Returns the screenshot as raw base64 (no data: prefix), or throws UpstreamError on any CDP failure.
export async function captureCdpScreenshot(cdpHttpBase: string, opts: CaptureCdpOptions = {}): Promise<string> {
  const fetchImpl = opts.fetch ?? fetch;
  const connect = opts.connect ?? ((url: string) => new WebSocket(url) as unknown as CdpSocket);
  const timeoutMs = opts.timeoutMs ?? 10_000;

  const listRes = await fetchImpl(`${cdpHttpBase}/json`);
  if (!listRes.ok) throw new UpstreamError("UPSTREAM_ERROR", { status: listRes.status }, "CDP /json unreachable.");
  const targets = (await listRes.json()) as CdpTarget[];
  const page =
    targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl) ?? targets.find((t) => t.webSocketDebuggerUrl);
  const wsUrl = page?.webSocketDebuggerUrl;
  if (!wsUrl) throw new UpstreamError("UPSTREAM_ERROR", undefined, "No CDP page target to capture.");

  return await new Promise<string>((resolve, reject) => {
    const ws = connect(wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new UpstreamError("UPSTREAM_ERROR", undefined, "CDP screenshot timed out."));
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
      ws.send(JSON.stringify({ id: 1, method: "Page.captureScreenshot", params: { format: "png" } }));
    });
    ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as {
          id?: number;
          result?: { data?: string };
          error?: { message?: string };
        };
        if (msg.id !== 1) return; // ignore CDP events; wait for our reply
        if (msg.error)
          return done(() => reject(new UpstreamError("UPSTREAM_ERROR", undefined, msg.error?.message ?? "CDP error")));
        const data = msg.result?.data;
        if (!data)
          return done(() => reject(new UpstreamError("UPSTREAM_ERROR", undefined, "CDP returned no image data.")));
        done(() => resolve(data));
      } catch (e) {
        done(() => reject(new UpstreamError("UPSTREAM_ERROR", undefined, e instanceof Error ? e.message : String(e))));
      }
    });
    ws.addEventListener("error", () =>
      done(() => reject(new UpstreamError("UPSTREAM_ERROR", undefined, "CDP socket error."))),
    );
  });
}
