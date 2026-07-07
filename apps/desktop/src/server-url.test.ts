import { describe, expect, it } from "vitest";
import { normalizeWebUrl, resolveWebUrl } from "./server-url.js";

describe("normalizeWebUrl", () => {
  it("allows only http/https URLs and strips the trailing slash", () => {
    expect(normalizeWebUrl("https://everdict.example.com/")).toBe("https://everdict.example.com");
    expect(normalizeWebUrl("  http://localhost:3001  ")).toBe("http://localhost:3001");
  });

  it("returns null for empty / non-URL / non-http schemes", () => {
    expect(normalizeWebUrl(undefined)).toBeNull();
    expect(normalizeWebUrl("")).toBeNull();
    expect(normalizeWebUrl("   ")).toBeNull();
    expect(normalizeWebUrl("not-a-url")).toBeNull();
    expect(normalizeWebUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeWebUrl("javascript:alert(1)")).toBeNull();
  });
});

describe("resolveWebUrl", () => {
  it("precedence: env > config > CI-injected default", () => {
    expect(
      resolveWebUrl({ envUrl: "http://e2e:3131", configUrl: "https://user.example", bakedUrl: "https://baked" }),
    ).toBe("http://e2e:3131");
    expect(resolveWebUrl({ configUrl: "https://user.example", bakedUrl: "https://baked" })).toBe(
      "https://user.example",
    );
    expect(resolveWebUrl({ bakedUrl: "https://baked" })).toBe("https://baked");
  });

  it("falls back to the next source when a higher-priority source is invalid", () => {
    expect(resolveWebUrl({ envUrl: "nope", configUrl: "https://user.example" })).toBe("https://user.example");
  });

  it("null when all are absent — go to the first-run setup screen", () => {
    expect(resolveWebUrl({})).toBeNull();
  });
});
