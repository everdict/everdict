import { describe, expect, it } from "vitest";
import { allowTopLevelNavigation, decideWindowOpen, webOriginOf } from "./window-policy.js";

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
