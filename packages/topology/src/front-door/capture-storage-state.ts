import { UpstreamError } from "@everdict/contracts";
import type { CaptureCdpOptions, CdpSocket, CdpTarget } from "./capture-cdp.js";
import { reachableWsUrl } from "./cdp-ws.js";

// Capture the login state of a running browser over CDP (browser-profiles S3) — the sibling of capture-cdp's
// screenshot. Given a running Chrome DevTools Protocol HTTP base (the interactive session's browser), read every
// cookie via `Network.getAllCookies` → a Playwright-style storageState the profile stores (encrypted) and later
// injects into an eval browser (S5). Transport-injectable so it is unit-testable without a real browser.
//
// localStorage capture (per-origin `Runtime.evaluate`) is deferred — cookies are the login material for most sites.

export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string; // CDP: "Strict" | "Lax" | "None"
}
export interface StorageState {
  cookies: StoredCookie[];
}

// A raw CDP cookie (Network.Cookie) — we keep only the fields needed to re-seed it later (Network.setCookies).
interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

// Read every cookie from the browser at cdpHttpBase. Throws UpstreamError on any CDP failure.
export async function captureStorageState(cdpHttpBase: string, opts: CaptureCdpOptions = {}): Promise<StorageState> {
  const fetchImpl = opts.fetch ?? fetch;
  const connect = opts.connect ?? ((url: string) => new WebSocket(url) as unknown as CdpSocket);
  const timeoutMs = opts.timeoutMs ?? 10_000;

  const listRes = await fetchImpl(`${cdpHttpBase}/json`);
  if (!listRes.ok) throw new UpstreamError("UPSTREAM_ERROR", { status: listRes.status }, "CDP /json unreachable.");
  const targets = (await listRes.json()) as CdpTarget[];
  const wsUrl = (
    targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl) ?? targets.find((t) => t.webSocketDebuggerUrl)
  )?.webSocketDebuggerUrl;
  if (!wsUrl) throw new UpstreamError("UPSTREAM_ERROR", undefined, "No CDP page target to capture cookies from.");

  return await new Promise<StorageState>((resolve, reject) => {
    const ws = connect(reachableWsUrl(wsUrl, cdpHttpBase));
    const timer = setTimeout(() => {
      ws.close();
      reject(new UpstreamError("UPSTREAM_ERROR", undefined, "CDP cookie capture timed out."));
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
      ws.send(JSON.stringify({ id: 1, method: "Network.getAllCookies" }));
    });
    ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as {
          id?: number;
          result?: { cookies?: CdpCookie[] };
          error?: { message?: string };
        };
        if (msg.id !== 1) return; // ignore CDP events; wait for our reply
        if (msg.error)
          return done(() => reject(new UpstreamError("UPSTREAM_ERROR", undefined, msg.error?.message ?? "CDP error")));
        const cookies = (msg.result?.cookies ?? []).map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          ...(c.expires !== undefined ? { expires: c.expires } : {}),
          ...(c.httpOnly !== undefined ? { httpOnly: c.httpOnly } : {}),
          ...(c.secure !== undefined ? { secure: c.secure } : {}),
          ...(c.sameSite !== undefined ? { sameSite: c.sameSite } : {}),
        }));
        done(() => resolve({ cookies }));
      } catch (e) {
        done(() => reject(new UpstreamError("UPSTREAM_ERROR", undefined, e instanceof Error ? e.message : String(e))));
      }
    });
    ws.addEventListener("error", () =>
      done(() => reject(new UpstreamError("UPSTREAM_ERROR", undefined, "CDP socket error."))),
    );
  });
}

// The unique cookie domains in a storageState (leading dot stripped) — recorded on the profile for display/filtering.
export function storageStateDomains(state: StorageState): string[] {
  return [...new Set(state.cookies.map((c) => c.domain.replace(/^\./, "")).filter(Boolean))].sort();
}

// Seed a captured storageState INTO a running browser over CDP (browser-profiles S5) — the inverse of
// captureStorageState. Given a running Chrome's CDP HTTP base and a Playwright-style storageState, set every cookie
// via `Network.setCookies` so a browser eval that attaches afterwards is already logged-in. A no-op for an empty
// state. Throws UpstreamError on any CDP failure. Transport-injectable (fetch/connect) for unit tests.
export async function seedStorageState(
  cdpHttpBase: string,
  state: StorageState,
  opts: CaptureCdpOptions = {},
): Promise<void> {
  if (state.cookies.length === 0) return;
  const fetchImpl = opts.fetch ?? fetch;
  const connect = opts.connect ?? ((url: string) => new WebSocket(url) as unknown as CdpSocket);
  const timeoutMs = opts.timeoutMs ?? 10_000;

  const listRes = await fetchImpl(`${cdpHttpBase}/json`);
  if (!listRes.ok) throw new UpstreamError("UPSTREAM_ERROR", { status: listRes.status }, "CDP /json unreachable.");
  const targets = (await listRes.json()) as CdpTarget[];
  const wsUrl = (
    targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl) ?? targets.find((t) => t.webSocketDebuggerUrl)
  )?.webSocketDebuggerUrl;
  if (!wsUrl) throw new UpstreamError("UPSTREAM_ERROR", undefined, "No CDP page target to seed cookies into.");

  await new Promise<void>((resolve, reject) => {
    const ws = connect(reachableWsUrl(wsUrl, cdpHttpBase));
    const timer = setTimeout(() => {
      ws.close();
      reject(new UpstreamError("UPSTREAM_ERROR", undefined, "CDP cookie seed timed out."));
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
      ws.send(JSON.stringify({ id: 1, method: "Network.setCookies", params: { cookies: state.cookies } }));
    });
    ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as { id?: number; error?: { message?: string } };
        if (msg.id !== 1) return; // ignore CDP events; wait for our reply
        if (msg.error)
          return done(() => reject(new UpstreamError("UPSTREAM_ERROR", undefined, msg.error?.message ?? "CDP error")));
        done(() => resolve());
      } catch (e) {
        done(() => reject(new UpstreamError("UPSTREAM_ERROR", undefined, e instanceof Error ? e.message : String(e))));
      }
    });
    ws.addEventListener("error", () =>
      done(() => reject(new UpstreamError("UPSTREAM_ERROR", undefined, "CDP socket error."))),
    );
  });
}
