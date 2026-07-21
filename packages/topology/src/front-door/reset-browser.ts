import { UpstreamError } from "@everdict/contracts";
import type { CaptureCdpOptions, CdpSocket, CdpTarget } from "./capture-cdp.js";
import { reachableWsUrl } from "./cdp-ws.js";

// Wipe a running browser's login state over CDP so a POOLED headless-shell can be safely re-leased to the NEXT
// interactive session (browser-profiles remote provisioner). A pool member is a whole dedicated browser handed to
// one session at a time; on release we must clear the previous user's credentials before the next lease, or user B
// would inherit user A's logins. The wipe is: `Network.clearBrowserCookies` (the login material capture reads —
// see capture-storage-state) + `Storage.clearDataForOrigin` for every storage kind + navigate back to about:blank.
// Fail-closed: the caller QUARANTINES a member whose reset throws (never re-leases a dirty browser). Extra tabs the
// user opened are closed via the /json/close HTTP endpoint before the socket work. Transport-injectable for tests.
export async function resetBrowserState(cdpHttpBase: string, opts: CaptureCdpOptions = {}): Promise<void> {
  const fetchImpl = opts.fetch ?? fetch;
  const connect = opts.connect ?? ((url: string) => new WebSocket(url) as unknown as CdpSocket);
  const timeoutMs = opts.timeoutMs ?? 10_000;

  const listRes = await fetchImpl(`${cdpHttpBase}/json`);
  if (!listRes.ok) throw new UpstreamError("UPSTREAM_ERROR", { status: listRes.status }, "CDP /json unreachable.");
  const targets = (await listRes.json()) as Array<CdpTarget & { id?: string }>;
  const pages = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
  // Keep exactly one page to drive the reset commands on; close every other tab/popup the session left behind.
  const keep = pages[0];
  const wsUrl = keep?.webSocketDebuggerUrl;
  if (!wsUrl) throw new UpstreamError("UPSTREAM_ERROR", undefined, "No CDP page target to reset the browser on.");
  for (const extra of pages.slice(1)) {
    if (extra.id) await fetchImpl(`${cdpHttpBase}/json/close/${extra.id}`).catch(() => undefined);
  }

  await new Promise<void>((resolve, reject) => {
    const ws = connect(reachableWsUrl(wsUrl, cdpHttpBase));
    const timer = setTimeout(() => {
      ws.close();
      reject(new UpstreamError("UPSTREAM_ERROR", undefined, "CDP browser reset timed out."));
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
    // Command pipeline (replies arrive in order): clear cookies → clear all storage kinds → blank the page. The
    // cookie clear (id 1) and navigate (id 3) are the credential wipe — an error there REJECTS so the caller
    // quarantines the member. The storage clear (id 2) is best-effort: `origin:"*"` is not accepted by every Chromium
    // build, and cookies (id 1) are the only login material capture actually reads, so its error is ignored not fatal.
    const COOKIES_ID = 1;
    const NAVIGATE_ID = 3;
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id: COOKIES_ID, method: "Network.clearBrowserCookies" }));
      // origin "*" clears every origin's storage (localStorage/indexeddb/etc.) where supported — defense in depth.
      ws.send(
        JSON.stringify({ id: 2, method: "Storage.clearDataForOrigin", params: { origin: "*", storageTypes: "all" } }),
      );
      ws.send(JSON.stringify({ id: NAVIGATE_ID, method: "Page.navigate", params: { url: "about:blank" } }));
    });
    ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as { id?: number; error?: { message?: string } };
        // Only the fatal steps (cookie clear, navigate) fail the reset; a storage-clear error is tolerated.
        if (msg.error && (msg.id === COOKIES_ID || msg.id === NAVIGATE_ID))
          return done(() => reject(new UpstreamError("UPSTREAM_ERROR", undefined, msg.error?.message ?? "CDP error")));
        if (msg.id !== NAVIGATE_ID) return; // wait for the final command's reply
        done(() => resolve());
      } catch (e) {
        done(() => reject(new UpstreamError("UPSTREAM_ERROR", undefined, e instanceof Error ? e.message : String(e))));
      }
    });
    ws.addEventListener("error", () =>
      done(() => reject(new UpstreamError("UPSTREAM_ERROR", undefined, "CDP browser reset socket error."))),
    );
  });
}
