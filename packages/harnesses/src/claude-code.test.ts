import type { ComputeHandle, ExecChunk, ExecOpts, ExecResult, RunContext, TraceEvent } from "@everdict/contracts";
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

// A compute WITH execStream: delivers the given chunks one macrotask apart (so line boundaries and event
// interleaving are real), then resolves with the exec result — the streaming-session shape of the driver.
class StreamingMockCompute implements ComputeHandle {
  lastEnv: Record<string, string> | undefined;
  lastCmd = "";
  constructor(
    private readonly chunks: string[],
    private readonly result: Omit<ExecResult, "stdout"> = { exitCode: 0, stderr: "" },
  ) {}
  async exec(): Promise<ExecResult> {
    throw new Error("streaming mock: exec must not be used when execStream is present");
  }
  async execStream(cmd: string, onChunk: (chunk: ExecChunk) => void, opts?: ExecOpts): Promise<ExecResult> {
    this.lastCmd = cmd;
    this.lastEnv = opts?.env;
    let stdout = "";
    for (const data of this.chunks) {
      await new Promise((r) => setTimeout(r, 0));
      stdout += data;
      onChunk({ stream: "stdout", data });
    }
    return { ...this.result, stdout };
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
    // Regression (live-found in the playground's docker session): the claude binary refuses
    // --dangerously-skip-permissions as root unless IS_SANDBOX is set — and this harness only ever runs
    // inside a Driver-provisioned sandbox, so the flag is forced.
    expect(compute.lastEnv?.IS_SANDBOX).toBe("1");
    expect(compute.lastCmd).toContain("--output-format stream-json");
    expect(events.map((e) => e.kind)).toEqual(["message", "tool_call", "llm_call", "tool_result", "llm_call"]);
    const agg = events.find((e) => e.kind === "llm_call" && e.model === "aggregate");
    expect(agg?.kind === "llm_call" && agg.cost?.usd).toBe(0.01);
  });

  it("on a streaming compute, yields events incrementally per line and identical to the buffered parse", async () => {
    // Given the same stream-json split across chunk boundaries MID-LINE
    const lines = STREAM.split("\n");
    const chunks = [`${lines[0]?.slice(0, 25)}`, `${lines[0]?.slice(25)}\n${lines[1]}\n`, `${lines[2]}\n`];
    const streaming = new StreamingMockCompute(chunks);
    const ctx: RunContext = { apiKeyEnv: { CLAUDE_CODE_OAUTH_TOKEN: "tok-123" }, timeoutSec: 60 };

    // When the harness runs, record how many chunks had been delivered when each event arrived
    const events: TraceEvent[] = [];
    for await (const ev of new ClaudeCodeHarness("cli").run(streaming, "do it", ctx)) events.push(ev);

    // Then: identical event sequence to the buffered path (same mapper), auth env still injected
    expect(streaming.lastEnv?.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok-123");
    expect(events.map((e) => e.kind)).toEqual(["message", "tool_call", "llm_call", "tool_result", "llm_call"]);
    const agg = events.find((e) => e.kind === "llm_call" && e.model === "aggregate");
    expect(agg?.kind === "llm_call" && agg.cost?.usd).toBe(0.01);
  });

  it("streams the first event BEFORE the exec settles (live monitoring, not a post-exit replay)", async () => {
    // A compute whose exec result is gated on a flag the test controls: the final chunk (and settle)
    // only happens after we have observed the first yielded event.
    let releaseTail: (() => void) | undefined;
    const tailGate = new Promise<void>((r) => {
      releaseTail = r;
    });
    const lines = STREAM.split("\n");
    class GatedCompute extends StreamingMockCompute {
      override async execStream(
        cmd: string,
        onChunk: (chunk: ExecChunk) => void,
        opts?: ExecOpts,
      ): Promise<ExecResult> {
        onChunk({ stream: "stdout", data: `${lines[0]}\n` });
        await tailGate;
        onChunk({ stream: "stdout", data: `${lines[1]}\n${lines[2]}\n` });
        return { exitCode: 0, stdout: STREAM, stderr: "" };
      }
    }
    const ctx: RunContext = { apiKeyEnv: {}, timeoutSec: 60 };
    const events: TraceEvent[] = [];
    for await (const ev of new ClaudeCodeHarness("cli").run(new GatedCompute([]), "do it", ctx)) {
      events.push(ev);
      // First events arrive while the exec is still gated open — release the tail only now.
      if (events.length === 1) releaseTail?.();
    }
    expect(events.length).toBeGreaterThan(3); // the full sequence still completed after release
  });

  it("surfaces a hard CLI failure on the streaming path as a trace error event", async () => {
    const streaming = new StreamingMockCompute([""], { exitCode: 2, stderr: "boom: claude broke" });
    const ctx: RunContext = { apiKeyEnv: {}, timeoutSec: 60 };
    const events: TraceEvent[] = [];
    for await (const ev of new ClaudeCodeHarness("cli").run(streaming, "do it", ctx)) events.push(ev);
    const err = events.find((e) => e.kind === "error");
    expect(err?.kind === "error" && err.message).toContain("boom");
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
