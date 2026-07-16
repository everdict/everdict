// Rewrite a CDP-reported webSocketDebuggerUrl's authority (host:port) to the CDP HTTP base the control plane actually
// reached the browser on (browser-profiles S6). A browser in a container reports its INTERNAL debugging port (e.g.
// :9222) in /json, which is wrong from the host's PUBLISHED port; the control plane must connect via the reachable
// authority. A no-op when they already match (host Chrome). The path (/devtools/page/<id>) + scheme are preserved.
export function reachableWsUrl(wsUrl: string, cdpHttpBase: string): string {
  try {
    const target = new URL(wsUrl);
    target.host = new URL(cdpHttpBase).host; // authority = the reachable host:port
    return target.toString();
  } catch {
    return wsUrl; // unparseable — leave as-is
  }
}
