import { describe, expect, it } from "vitest";
import { ModelSpecSchema } from "./model-spec.js";

describe("ModelSpecSchema", () => {
  it("carries the companion tiers a workspace tunes its agent with (all optional)", () => {
    const spec = ModelSpecSchema.parse({
      id: "agent-main",
      version: "1.0.0",
      provider: "openai",
      model: "gpt-5.5",
      companions: { small: "agent-small", fallback: "agent-fallback" }, // subagent omitted — each slot independent
    });
    expect(spec.companions).toEqual({ small: "agent-small", fallback: "agent-fallback" });
    // A spec without companions stays valid — the deployment defaults then apply.
    expect(ModelSpecSchema.parse({ id: "m", version: "1.0.0", model: "x" }).companions).toBeUndefined();
  });
});
