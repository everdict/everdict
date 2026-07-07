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

// Server-address recovery (D8): when the pinned web URL fails to load, the app window is a dead error page. If the OS
// tray is unavailable (common on Linux) the only "Change server address" affordance is gone — a mistyped/unreachable
// URL becomes unrecoverable. So on the *initial* main-frame load failure, fall back to the setup screen. Guards:
//  - non-main-frame failures (sub-resources/iframes) never strand the user → ignore.
//  - errorCode -3 (ERR_ABORTED) is a benign navigation abort (OIDC redirects, superseded loads) → ignore.
//  - once the server has loaded successfully (everLoaded), a later transient failure must NOT yank a working session
//    back to setup → ignore.
export function shouldRecoverToSetup(params: {
  errorCode: number;
  isMainFrame: boolean;
  everLoaded: boolean;
}): boolean {
  if (!params.isMainFrame) return false;
  if (params.errorCode === -3) return false;
  if (params.everLoaded) return false;
  return true;
}
