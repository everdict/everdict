import type { ComputeHandle } from "@everdict/core";
import { describe, expect, it } from "vitest";
import { PromptEnvironment } from "./prompt.js";

// seed/snapshot 은 compute 를 안 쓰므로 호출되면 실패하는 스텁(무대 없음을 보장).
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

describe("PromptEnvironment (환경 없는 QA)", () => {
  it("seed 는 무대 없음(no-op), snapshot 은 {kind:prompt}", async () => {
    const env = new PromptEnvironment();
    expect(env.kind).toBe("prompt");
    await env.seed(noCompute, { kind: "prompt" }); // exec 안 함 → throw 없음
    expect(await env.snapshot(noCompute)).toEqual({ kind: "prompt", output: "" });
  });

  it("prompt 가 아닌 spec 은 거부", async () => {
    await expect(new PromptEnvironment().seed(noCompute, { kind: "repo", source: { files: {} } })).rejects.toThrow();
  });
});
