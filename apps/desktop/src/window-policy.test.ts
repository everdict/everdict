import { describe, expect, it } from "vitest";
import { allowTopLevelNavigation, decideWindowOpen, shouldRecoverToSetup, webOriginOf } from "./window-policy.js";

const WEB = "https://app.everdict.dev";

describe("webOriginOf", () => {
  it("extracts only the origin from a URL (ignores path/query)", () => {
    expect(webOriginOf("https://app.everdict.dev/ws/runs?x=1")).toBe("https://app.everdict.dev");
  });

  it("throws on a bad web URL (failing startup is correct)", () => {
    expect(() => webOriginOf("not-a-url")).toThrow();
  });
});

describe("decideWindowOpen", () => {
  it("allows a web-origin new window inside the app", () => {
    expect(decideWindowOpen(`${WEB}/acme/runs/1`, WEB)).toBe("in-app");
  });

  it("sends another http/https origin to the system browser", () => {
    expect(decideWindowOpen("https://github.com/octo/repo", WEB)).toBe("external");
    expect(decideWindowOpen("http://mattermost.internal/hook", WEB)).toBe("external");
  });

  it("blocks non-http/https schemes (javascript:/file:) and non-URLs", () => {
    expect(decideWindowOpen("javascript:alert(1)", WEB)).toBe("deny");
    expect(decideWindowOpen("file:///etc/passwd", WEB)).toBe("deny");
    expect(decideWindowOpen("%%%", WEB)).toBe("deny");
  });
});

describe("allowTopLevelNavigation", () => {
  it("allows http/https top-level navigation regardless of origin (for OIDC/OAuth redirects)", () => {
    expect(allowTopLevelNavigation("https://keycloak.everdict.dev/realms/everdict/auth")).toBe(true);
    expect(allowTopLevelNavigation("https://github.com/login/oauth/authorize")).toBe(true);
  });

  it("blocks file:/javascript:/non-URLs", () => {
    expect(allowTopLevelNavigation("file:///etc/passwd")).toBe(false);
    expect(allowTopLevelNavigation("javascript:alert(1)")).toBe(false);
    expect(allowTopLevelNavigation("nope")).toBe(false);
  });
});

describe("shouldRecoverToSetup", () => {
  it("recovers to setup when the pinned server fails its initial main-frame load (mistyped/unreachable URL)", () => {
    // Given a wrong/unreachable server URL that has never loaded, When its top-level load fails, Then route to setup.
    expect(shouldRecoverToSetup({ errorCode: -106, isMainFrame: true, everLoaded: false })).toBe(true); // ERR_INTERNET_DISCONNECTED
    expect(shouldRecoverToSetup({ errorCode: -102, isMainFrame: true, everLoaded: false })).toBe(true); // ERR_CONNECTION_REFUSED
  });

  it("ignores sub-resource (non-main-frame) failures so a broken asset doesn't strand the user", () => {
    expect(shouldRecoverToSetup({ errorCode: -102, isMainFrame: false, everLoaded: false })).toBe(false);
  });

  it("ignores ERR_ABORTED (-3) — a benign navigation abort during OIDC redirects", () => {
    expect(shouldRecoverToSetup({ errorCode: -3, isMainFrame: true, everLoaded: false })).toBe(false);
  });

  it("does not yank a working session to setup once the server has loaded", () => {
    expect(shouldRecoverToSetup({ errorCode: -102, isMainFrame: true, everLoaded: true })).toBe(false);
  });
});
