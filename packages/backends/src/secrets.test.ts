import { describe, expect, it } from "vitest";
import { staticSecrets } from "./secrets.js";

describe("staticSecrets", () => {
  it("테넌트마다 자기 시크릿만 받는다 (누출 없음)", async () => {
    const p = staticSecrets({
      acme: { ANTHROPIC_API_KEY: "sk-acme" },
      globex: { ANTHROPIC_API_KEY: "sk-globex" },
    });
    expect(await p.secretsFor("acme")).toEqual({ ANTHROPIC_API_KEY: "sk-acme" });
    expect((await p.secretsFor("globex")).ANTHROPIC_API_KEY).toBe("sk-globex");
    expect((await p.secretsFor("acme")).ANTHROPIC_API_KEY).not.toBe((await p.secretsFor("globex")).ANTHROPIC_API_KEY);
  });

  it("미등록 테넌트는 fallback(기본 빈 값)", async () => {
    expect(await staticSecrets({}).secretsFor("x")).toEqual({});
    expect(await staticSecrets({}, { K: "v" }).secretsFor("x")).toEqual({ K: "v" });
  });

  it("반환 객체는 복사본이라 변형해도 원본에 영향 없음", async () => {
    const p = staticSecrets({ a: { K: "v" } });
    (await p.secretsFor("a")).K = "tampered";
    expect((await p.secretsFor("a")).K).toBe("v");
  });
});
