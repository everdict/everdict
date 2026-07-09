import { describe, expect, it } from "vitest";
import { staticSecrets } from "./secrets.js";

describe("staticSecrets", () => {
  it("each tenant gets only its own secrets (no leakage)", async () => {
    const p = staticSecrets({
      acme: { ANTHROPIC_API_KEY: "sk-acme" },
      globex: { ANTHROPIC_API_KEY: "sk-globex" },
    });
    expect(await p.secretsFor("acme")).toEqual({ ANTHROPIC_API_KEY: "sk-acme" });
    expect((await p.secretsFor("globex")).ANTHROPIC_API_KEY).toBe("sk-globex");
    expect((await p.secretsFor("acme")).ANTHROPIC_API_KEY).not.toBe((await p.secretsFor("globex")).ANTHROPIC_API_KEY);
  });

  it("an unregistered tenant gets the fallback (empty by default)", async () => {
    expect(await staticSecrets({}).secretsFor("x")).toEqual({});
    expect(await staticSecrets({}, { K: "v" }).secretsFor("x")).toEqual({ K: "v" });
  });

  it("the returned object is a copy, so mutating it doesn't affect the original", async () => {
    const p = staticSecrets({ a: { K: "v" } });
    (await p.secretsFor("a")).K = "tampered";
    expect((await p.secretsFor("a")).K).toBe("v");
  });
});
