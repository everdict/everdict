import { describe, expect, it } from "vitest";
import { priceUsd } from "./pricing.js";

describe("priceUsd", () => {
  it("prices a known model by input/output tokens at its per-1M list price", () => {
    // opus tier: $15/1M input, $75/1M output
    expect(priceUsd("claude-opus-4-8", { inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(15, 6);
    expect(priceUsd("claude-opus-4-8", { inputTokens: 0, outputTokens: 1_000_000 })).toBeCloseTo(75, 6);
    expect(priceUsd("claude-opus-4-8", { inputTokens: 500_000, outputTokens: 200_000 })).toBeCloseTo(7.5 + 15, 6);
  });

  it("matches by substring so version suffixes still resolve", () => {
    expect(priceUsd("claude-sonnet-5", { inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(3, 6);
    expect(priceUsd("claude-haiku-4-5-20251001", { inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(0.8, 6);
  });

  it("prefers the more specific gpt-4o-mini over gpt-4o (order matters)", () => {
    expect(priceUsd("gpt-4o-mini", { inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(0.15, 6);
    expect(priceUsd("gpt-4o", { inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(2.5, 6);
  });

  it("returns $0 for an unknown model (its tokens are still metered)", () => {
    expect(priceUsd("some-local-llama", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(0);
    expect(priceUsd("", { inputTokens: 10, outputTokens: 10 })).toBe(0);
  });
});
