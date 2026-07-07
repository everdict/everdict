// Window navigation policy — pure functions (no electron dependency, easy to test). Design: docs/architecture/desktop-app.md D1/D4/D5.
//
// The app window is "a browser tab pinned to the deployed web". Top-level navigation is allowed for http/https —
// because Keycloak OIDC login and connected-account OAuth are flows that redirect back through outside the web
// origin (Keycloak/GitHub), allowing only the web origin would break login itself. Local permission (the bridge) is
// enforced not by the navigation policy but by the IPC-layer sender origin check (slice 3).
// window.open (a new window) allows only the web origin inside the app and hands other http/https to the system browser.

export type WindowOpenDecision = "in-app" | "external" | "deny";

// The configured web URL → origin (the comparison baseline). A bad URL should fail startup, so let it throw.
export function webOriginOf(webUrl: string): string {
  return new URL(webUrl).origin;
}

// window.open / target=_blank decision: web origin = in-app new window, other http/https = system browser, everything else (javascript:, etc.) = blocked.
export function decideWindowOpen(target: string, webOrigin: string): WindowOpenDecision {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return "deny";
  }
  if (url.origin === webOrigin) return "in-app";
  return url.protocol === "http:" || url.protocol === "https:" ? "external" : "deny";
}

// Top-level navigation decision: http/https only (the OIDC/OAuth redirect rationale above). file:/javascript: etc. are blocked.
export function allowTopLevelNavigation(target: string): boolean {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  return url.protocol === "http:" || url.protocol === "https:";
}
