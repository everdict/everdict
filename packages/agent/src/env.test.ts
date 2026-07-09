import { afterEach, describe, expect, it } from "vitest";
import { runContextFromEnv } from "./env.js";

describe("runContextFromEnv timeout boundary", () => {
  const original = process.env.EVERDICT_TIMEOUT_SEC;
  afterEach(() => {
    // Reflect.deleteProperty actually removes the key; `process.env.X = undefined` would coerce it to the string
    // "undefined" (env values are always strings), which is not the same as absent.
    if (original === undefined) Reflect.deleteProperty(process.env, "EVERDICT_TIMEOUT_SEC");
    else process.env.EVERDICT_TIMEOUT_SEC = original;
  });

  it("defaults to 300s when EVERDICT_TIMEOUT_SEC is absent", () => {
    Reflect.deleteProperty(process.env, "EVERDICT_TIMEOUT_SEC");
    expect(runContextFromEnv().timeoutSec).toBe(300);
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
