import { describe, expect, it } from "vitest";
import { contextWindowFor, effectiveBudget, estimateTokens, thresholdReached } from "./token-budget.js";

describe("contextWindowFor", () => {
  it("resolves known models by substring (order-sensitive), else the default", () => {
    expect(contextWindowFor("chatgpt/gpt-5.4-mini")).toBe(400_000);
    expect(contextWindowFor("anthropic/claude-opus-4-8")).toBe(200_000);
    expect(contextWindowFor("gpt-4o-mini")).toBe(128_000); // gpt-4o matches before gpt-4
    expect(contextWindowFor("gpt-4.1")).toBe(1_000_000);
    expect(contextWindowFor("some-unknown-model")).toBe(128_000);
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
