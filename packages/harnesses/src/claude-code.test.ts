import type { ComputeHandle, ExecOpts, ExecResult, RunContext, TraceEvent } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { ClaudeCodeHarness } from "./claude-code.js";

// Without actually calling claude, deterministically verify the injected auth env and stream-json parsing.
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
  it("injects the sandbox subscription token into the compute exec env and converts stream-json into a trace", async () => {
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

  it("stamps wall-clock event times from the injected clock, not a synthetic 0-based counter", async () => {
    // Given a stream and a deterministic wall clock that advances 1s per event
    const compute = new MockCompute(STREAM);
    const ctx: RunContext = { apiKeyEnv: {}, timeoutSec: 60 };
    const base = 1_700_000_000_000;
    let ms = base;
    const clock = () => {
      const value = ms;
      ms += 1000;
      return value;
    };

    // When the harness runs with the injected clock
    const events: TraceEvent[] = [];
    for await (const ev of new ClaudeCodeHarness("cli", { clock }).run(compute, "do it", ctx)) events.push(ev);

    // Then event times are wall-clock epoch ms (pre-fix they were 0,1,2,… from a synthetic counter)
    expect(events[0]?.t).toBe(base);
    expect(events.every((e) => e.t >= base)).toBe(true);
    // And the latency span is real elapsed time, not the event count (pre-fix span === events.length - 1)
    const span = (events[events.length - 1]?.t ?? 0) - (events[0]?.t ?? 0);
    expect(span).toBe((events.length - 1) * 1000);
    expect(span).toBeGreaterThan(events.length);
  });
});
