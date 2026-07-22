import { afterEach, describe, expect, it } from "vitest";
import { collectAuthEnv, runContextFromEnv } from "./env.js";

describe("runContextFromEnv timeout boundary", () => {
  const original = process.env.EVERDICT_TIMEOUT_SEC;
  afterEach(() => {
    // Reflect.deleteProperty actually removes the key; `process.env.X = undefined` would coerce it to the string
    // "undefined" (env values are always strings), which is not the same as absent.
    if (original === undefined) Reflect.deleteProperty(process.env, "EVERDICT_TIMEOUT_SEC");
    else process.env.EVERDICT_TIMEOUT_SEC = original;
  });

  it("defaults to 300s when EVERDICT_TIMEOUT_SEC and the per-case fallback are both absent", () => {
    Reflect.deleteProperty(process.env, "EVERDICT_TIMEOUT_SEC");
    expect(runContextFromEnv().timeoutSec).toBe(300);
  });

  it("honors the per-case timeout when EVERDICT_TIMEOUT_SEC is absent (a long agent case is not clipped to 300s)", () => {
    // Regression: EvalCase.timeoutSec (e.g. terminal-bench's 900s) was dropped at execution — every case ran with the
    // hardcoded 300s, silently killing multi-minute agents. The dispatched agent now plumbs the per-case value here.
    Reflect.deleteProperty(process.env, "EVERDICT_TIMEOUT_SEC");
    expect(runContextFromEnv(900).timeoutSec).toBe(900);
  });

  it("lets EVERDICT_TIMEOUT_SEC (operator override) win over the per-case fallback", () => {
    process.env.EVERDICT_TIMEOUT_SEC = "600";
    expect(runContextFromEnv(900).timeoutSec).toBe(600);
  });

  it("parses a positive integer", () => {
    process.env.EVERDICT_TIMEOUT_SEC = "600";
    expect(runContextFromEnv().timeoutSec).toBe(600);
  });

  it("throws on a non-numeric value instead of silently yielding NaN", () => {
    // Regression: `Number("abc")` was NaN, which passed through and broke every downstream timeout comparison.
    process.env.EVERDICT_TIMEOUT_SEC = "abc";
    expect(() => runContextFromEnv()).toThrow(/positive integer/);
  });

  it("throws on a non-positive value", () => {
    process.env.EVERDICT_TIMEOUT_SEC = "0";
    expect(() => runContextFromEnv()).toThrow();
  });
});

describe("collectAuthEnv model endpoint forwarding", () => {
  const KEYS = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "ANTHROPIC_BASE_URL"] as const;
  const saved = new Map<string, string | undefined>(KEYS.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = v;
    }
  });

  it("forwards OPENAI_BASE_URL + OPENAI_API_KEY so a non-claude (OpenAI-compatible) agent reaches its gateway", () => {
    // Regression: only the 3 claude vars were forwarded — an OpenAI-based agent got a key but the base URL was dropped,
    // so it pointed at api.openai.com instead of the injected gateway (e.g. LiteLLM). Both must reach the harness.
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.OPENAI_BASE_URL = "http://host.docker.internal:4000/v1";
    const env = collectAuthEnv();
    expect(env.OPENAI_API_KEY).toBe("sk-test");
    expect(env.OPENAI_BASE_URL).toBe("http://host.docker.internal:4000/v1");
  });

  it("omits vars that are absent (no empty-string injection)", () => {
    for (const k of KEYS) Reflect.deleteProperty(process.env, k);
    const env = collectAuthEnv();
    for (const k of KEYS) expect(k in env).toBe(false);
  });
});
