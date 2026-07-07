import { describe, expect, it } from "vitest";
import { normalizeWebUrl, resolveWebUrl } from "./server-url.js";

describe("normalizeWebUrl", () => {
  it("http/https URL 만 허용하고 끝 슬래시를 정리한다", () => {
    expect(normalizeWebUrl("https://everdict.example.com/")).toBe("https://everdict.example.com");
    expect(normalizeWebUrl("  http://localhost:3001  ")).toBe("http://localhost:3001");
  });

  it("빈 값/비 URL/비 http 스킴은 null", () => {
    expect(normalizeWebUrl(undefined)).toBeNull();
    expect(normalizeWebUrl("")).toBeNull();
    expect(normalizeWebUrl("   ")).toBeNull();
    expect(normalizeWebUrl("not-a-url")).toBeNull();
    expect(normalizeWebUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeWebUrl("javascript:alert(1)")).toBeNull();
  });
});

describe("resolveWebUrl", () => {
  it("우선순위: env > config > CI 주입 기본값", () => {
    expect(
      resolveWebUrl({ envUrl: "http://e2e:3131", configUrl: "https://user.example", bakedUrl: "https://baked" }),
    ).toBe("http://e2e:3131");
    expect(resolveWebUrl({ configUrl: "https://user.example", bakedUrl: "https://baked" })).toBe(
      "https://user.example",
    );
    expect(resolveWebUrl({ bakedUrl: "https://baked" })).toBe("https://baked");
  });

  it("상위 소스가 잘못된 값이면 다음 소스로 폴백", () => {
    expect(resolveWebUrl({ envUrl: "nope", configUrl: "https://user.example" })).toBe("https://user.example");
  });

  it("전부 없으면 null — 첫 실행 설정 화면으로", () => {
    expect(resolveWebUrl({})).toBeNull();
  });
});
