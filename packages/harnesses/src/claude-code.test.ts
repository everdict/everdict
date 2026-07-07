import type { ComputeHandle, ExecOpts, ExecResult, RunContext, TraceEvent } from "@everdict/core";
import { describe, expect, it } from "vitest";
import { ClaudeCodeHarness } from "./claude-code.js";

// claude 를 실제로 부르지 않고, 주입된 인증 env 와 stream-json 파싱을 결정적으로 검증한다.
class MockCompute implements ComputeHandle {
  lastEnv: Record<string, string> | undefined;
  lastCmd = "";
  constructor(private readonly stdout: string) {}
  async exec(cmd: string, opts?: ExecOpts): Promise<ExecResult> {
    this.lastCmd = cmd;
    this.lastEnv = opts?.env;
    return { exitCode: 0, stdout: this.stdout, stderr: "" };
  }
  async writeFile(): Promise<void> {}
  async readFile(): Promise<string> {
    return "";
  }
  async dispose(): Promise<void> {}
}

const STREAM = [
  JSON.stringify({
    type: "assistant",
    message: {
      model: "claude-opus-4-8",
      content: [
        { type: "text", text: "hi" },
        { type: "tool_use", id: "t1", name: "Write", input: {} },
      ],
      usage: { input_tokens: 5, output_tokens: 1 },
    },
  }),
  JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok", is_error: false }] },
  }),
  JSON.stringify({ type: "result", total_cost_usd: 0.01 }),
].join("\n");

describe("ClaudeCodeHarness", () => {
  it("샌드박스용 구독 토큰을 compute 실행 env 로 주입하고 stream-json 을 트레이스로 변환한다", async () => {
    const compute = new MockCompute(STREAM);
    const ctx: RunContext = { apiKeyEnv: { CLAUDE_CODE_OAUTH_TOKEN: "tok-123" }, timeoutSec: 60 };

    const events: TraceEvent[] = [];
    for await (const ev of new ClaudeCodeHarness("cli").run(compute, "do it", ctx)) events.push(ev);

    expect(compute.lastEnv?.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok-123");
    expect(compute.lastCmd).toContain("--output-format stream-json");
    expect(events.map((e) => e.kind)).toEqual(["message", "tool_call", "llm_call", "tool_result", "llm_call"]);
    const agg = events.find((e) => e.kind === "llm_call" && e.model === "aggregate");
    expect(agg?.kind === "llm_call" && agg.cost?.usd).toBe(0.01);
  });
});
