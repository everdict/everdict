import { describe, expect, it } from "vitest";
import { contextWindowFor, effectiveBudget, estimateTokens, thresholdReached } from "./token-budget.js";

describe("contextWindowFor", () => {
  it("resolves known models by substring (order-sensitive), else the default", () => {
    expect(contextWindowFor("chatgpt/gpt-5.4-mini")).toBe(400_000);
    expect(contextWindowFor("gpt-4o-mini")).toBe(128_000); // gpt-4o matches before gpt-4
    expect(contextWindowFor("gpt-4.1")).toBe(1_000_000);
    expect(contextWindowFor("some-unknown-model")).toBe(128_000);
  });

  it("budgets 1M-context Claude models at 1M instead of capping them at 200k", () => {
    // Regression: the old table matched every "opus"/"sonnet"/"claude" at 200k, so a 1M model compacted at ~20%.
    expect(contextWindowFor("anthropic/claude-opus-4-8")).toBe(1_000_000);
    expect(contextWindowFor("claude-opus-5")).toBe(1_000_000);
    expect(contextWindowFor("claude-sonnet-4-6")).toBe(1_000_000);
    expect(contextWindowFor("claude-sonnet-5")).toBe(1_000_000);
    expect(contextWindowFor("claude-fable-5")).toBe(1_000_000);
  });

  it("keeps 200k-context Claude models at 200k (the allowlist is explicit, not tier-wide)", () => {
    expect(contextWindowFor("claude-opus-4-5-20251101")).toBe(200_000);
    expect(contextWindowFor("claude-sonnet-4-5-20250929")).toBe(200_000);
    expect(contextWindowFor("claude-haiku-4-5-20251001")).toBe(200_000);
    expect(contextWindowFor("claude-3-haiku-20240307")).toBe(200_000);
  });
});

describe("effectiveBudget", () => {
  it("subtracts the output reserve from the context window", () => {
    expect(effectiveBudget("gpt-4o")).toBe(128_000 - 32_000);
    expect(effectiveBudget("claude-sonnet")).toBe(200_000 - 32_000);
  });
});

describe("estimateTokens", () => {
  it("estimates text as length/4 and each image at a flat cost", () => {
    expect(estimateTokens([{ content: "x".repeat(400) }])).toBe(100);
    const withImage = [
      {
        content: [
          { type: "text", text: "hi" },
          { type: "image_url", image_url: { url: "data:x" } },
        ],
      },
    ];
    expect(estimateTokens(withImage)).toBe(Math.ceil(2 / 4) + 1_500);
    expect(estimateTokens([{ content: null }])).toBe(0);
  });
});

describe("thresholdReached", () => {
  it("fires at or above 90% of maxTokens", () => {
    expect(thresholdReached({ maxTokens: 100, consumed: 89 })).toBe(false);
    expect(thresholdReached({ maxTokens: 100, consumed: 90 })).toBe(true);
  });
});
