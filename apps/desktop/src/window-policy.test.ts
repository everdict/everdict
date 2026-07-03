import { describe, expect, it } from "vitest";
import { allowTopLevelNavigation, decideWindowOpen, webOriginOf } from "./window-policy.js";

const WEB = "https://app.assay.dev";

describe("webOriginOf", () => {
  it("URL 에서 origin 만 뽑는다(경로/쿼리 무시)", () => {
    expect(webOriginOf("https://app.assay.dev/ws/runs?x=1")).toBe("https://app.assay.dev");
  });

  it("잘못된 웹 URL 은 throw(기동 실패가 맞다)", () => {
    expect(() => webOriginOf("not-a-url")).toThrow();
  });
});

describe("decideWindowOpen", () => {
  it("웹 origin 새 창은 앱 안에 허용", () => {
    expect(decideWindowOpen(`${WEB}/acme/runs/1`, WEB)).toBe("in-app");
  });

  it("다른 http/https origin 은 시스템 브라우저로", () => {
    expect(decideWindowOpen("https://github.com/octo/repo", WEB)).toBe("external");
    expect(decideWindowOpen("http://mattermost.internal/hook", WEB)).toBe("external");
  });

  it("http/https 외 스킴(javascript:/file:)과 비 URL 은 차단", () => {
    expect(decideWindowOpen("javascript:alert(1)", WEB)).toBe("deny");
    expect(decideWindowOpen("file:///etc/passwd", WEB)).toBe("deny");
    expect(decideWindowOpen("%%%", WEB)).toBe("deny");
  });
});

describe("allowTopLevelNavigation", () => {
  it("OIDC/OAuth 경유를 위해 http/https 탑레벨 네비게이션은 origin 무관 허용", () => {
    expect(allowTopLevelNavigation("https://keycloak.assay.dev/realms/assay/auth")).toBe(true);
    expect(allowTopLevelNavigation("https://github.com/login/oauth/authorize")).toBe(true);
  });

  it("file:/javascript:/비 URL 은 차단", () => {
    expect(allowTopLevelNavigation("file:///etc/passwd")).toBe(false);
    expect(allowTopLevelNavigation("javascript:alert(1)")).toBe(false);
    expect(allowTopLevelNavigation("nope")).toBe(false);
  });
});
