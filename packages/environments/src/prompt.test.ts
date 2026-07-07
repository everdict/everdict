import type { ComputeHandle } from "@everdict/core";
import { describe, expect, it } from "vitest";
import { PromptEnvironment } from "./prompt.js";

// seed/snapshot don't use compute, so this stub fails if called (guaranteeing there's no stage).
const noCompute: ComputeHandle = {
  async exec() {
    throw new Error("prompt env should not exec");
  },
  async writeFile() {
    throw new Error("nope");
  },
  async readFile() {
    return "";
  },
  async dispose() {},
};

describe("PromptEnvironment (environment-less QA)", () => {
  it("seed has no stage (no-op), snapshot is {kind:prompt}", async () => {
    const env = new PromptEnvironment();
    expect(env.kind).toBe("prompt");
    await env.seed(noCompute, { kind: "prompt" }); // no exec → no throw
    expect(await env.snapshot(noCompute)).toEqual({ kind: "prompt", output: "" });
  });

  it("rejects a non-prompt spec", async () => {
    await expect(new PromptEnvironment().seed(noCompute, { kind: "repo", source: { files: {} } })).rejects.toThrow();
  });
});
