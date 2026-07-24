import type { LlmTransport, StreamRequest, StreamResult } from "@everdict/llm";
import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../messages.js";
import type { PermissionDecision, PermissionRequest, ToolDefinition } from "../tools/definition.js";
import { ToolRegistry } from "../tools/registry.js";
import { type AgentEvent, runAgentLoop } from "./loop.js";

// A fake transport that returns a pre-scripted StreamResult per successive call and records each request, so the loop
// can be driven deterministically without a provider. Fires onContentDelta once so text_delta emission is exercised.
function fakeTransport(results: StreamResult[]): { transport: LlmTransport; requests: StreamRequest[] } {
  const requests: StreamRequest[] = [];
  let call = 0;
  const transport: LlmTransport = {
    provider: "fake",
    stream: async (req) => {
      requests.push(req);
      const r = results[call] ?? { content: null, toolCalls: [], finishReason: "stop" };
      call += 1;
      if (r.content) req.onContentDelta?.(r.content);
      return r;
    },
  };
  return { transport, requests };
}

const usage7 = { inputTokens: 7, outputTokens: 0, totalTokens: 7 };

function textResult(text: string): StreamResult {
  return { content: text, toolCalls: [], finishReason: "stop", usage: usage7 };
}

function toolCallResult(id: string, name: string, args: string): StreamResult {
  return { content: null, toolCalls: [{ id, name, arguments: args }], finishReason: "tool_calls", usage: usage7 };
}

function toolCallsResult(calls: { id: string; name: string; args: string }[]): StreamResult {
  return {
    content: null,
    toolCalls: calls.map((c) => ({ id: c.id, name: c.name, arguments: c.args })),
    finishReason: "tool_calls",
    usage: usage7,
  };
}

const history: ChatMessage[] = [{ role: "user", content: "hello" }];

describe("runAgentLoop", () => {
  it("stops with end_turn when the model returns text and no tool calls", async () => {
    const { transport } = fakeTransport([textResult("Hi there")]);
    const result = await runAgentLoop({
      transport,
      model: "test-model",
      systemPrompt: "You are a test agent.",
      history,
      registry: new ToolRegistry([]),
    });
    expect(result.stopReason).toBe("end_turn");
    expect(result.content).toBe("Hi there");
    expect(result.turns).toBe(1);
    expect(result.toolCalls).toHaveLength(0);
  });

  it("dispatches a tool call, feeds the result back, then finishes", async () => {
    const call = vi.fn(async (input: unknown) => ({ content: `echo:${JSON.stringify(input)}`, isError: false }));
    const echo: ToolDefinition = {
      name: "echo",
      description: "echo the input",
      parametersJsonSchema: { type: "object", properties: { x: { type: "number" } } },
      isReadOnly: true,
      call,
    };
    const { transport } = fakeTransport([toolCallResult("call_1", "echo", '{"x":1}'), textResult("done")]);
    const seen: ChatMessage[] = [];
    const result = await runAgentLoop({
      transport,
      model: "test-model",
      systemPrompt: "You are a test agent.",
      history,
      registry: new ToolRegistry([echo]),
      onMessage: (m) => {
        seen.push(m);
      },
    });
    expect(call).toHaveBeenCalledWith({ x: 1 }, expect.objectContaining({ selectedModel: "test-model" }));
    expect(result.stopReason).toBe("end_turn");
    expect(result.content).toBe("done");
    expect(result.turns).toBe(2);
    expect(result.toolCalls).toEqual([{ name: "echo", ok: true }]);
    // The produced transcript pairs the assistant tool_call with its tool result.
    const roles = result.produced.map((m) => m.role);
    expect(roles).toEqual(["assistant", "tool", "assistant"]);
    // produced is accumulated as messages are appended (== what onMessage saw), not a tail slice of the context.
    expect(result.produced).toEqual(seen);
    // A tool-only assistant turn carries null content (not "") alongside tool_calls.
    const first = result.produced[0] as { content: unknown; tool_calls?: unknown[] };
    expect(first.content).toBeNull();
    expect(first.tool_calls).toHaveLength(1);
  });

  it("records a failed tool call without breaking the loop", async () => {
    const { transport } = fakeTransport([toolCallResult("call_1", "missing_tool", "{}"), textResult("recovered")]);
    const result = await runAgentLoop({
      transport,
      model: "test-model",
      systemPrompt: "sys",
      history,
      registry: new ToolRegistry([]),
    });
    expect(result.toolCalls).toEqual([{ name: "missing_tool", ok: false }]);
    expect(result.stopReason).toBe("end_turn");
    expect(result.content).toBe("recovered");
  });

  it("runs the compaction ladder when over the token budget (microcompact clears old tool results)", async () => {
    const big = "R".repeat(600);
    const longHistory: ChatMessage[] = [{ role: "user", content: "goal" }];
    for (let i = 0; i < 5; i++) {
      longHistory.push({
        role: "assistant",
        content: null,
        tool_calls: [{ id: `h${i}`, type: "function", function: { name: "noop", arguments: "{}" } }],
      });
      longHistory.push({ role: "tool", tool_call_id: `h${i}`, content: big });
    }
    longHistory.push({ role: "user", content: "continue" });

    const noop: ToolDefinition = {
      name: "noop",
      description: "noop",
      parametersJsonSchema: { type: "object", properties: {} },
      isReadOnly: true,
      call: async () => ({ content: "ok", isError: false }),
    };
    // turn 1: a tool call whose usage pushes past 90% of 900k → compaction after dispatch; turn 2: text → end_turn.
    const highUsageToolCall: StreamResult = {
      content: null,
      toolCalls: [{ id: "call_1", name: "noop", arguments: "{}" }],
      finishReason: "tool_calls",
      usage: { inputTokens: 850_000, outputTokens: 0, totalTokens: 850_000 },
    };
    const { transport } = fakeTransport([highUsageToolCall, textResult("done")]);
    const events: AgentEvent[] = [];
    const result = await runAgentLoop({
      transport,
      model: "test-model",
      systemPrompt: "sys",
      history: longHistory,
      registry: new ToolRegistry([noop]),
      summarize: async () => "digest", // keep the default summariser off the fake client (rung 1 wins here anyway)
      onEvent: (e) => events.push(e),
    });
    const compactions = events.filter((e) => e.type === "compaction");
    expect(compactions.length).toBeGreaterThan(0);
    expect((compactions[0] as { mode?: string }).mode).toBe("microcompact");
    expect(result.stopReason).toBe("end_turn");
  });

  it("surfaces tool-returned images as a follow-up multimodal user turn (in-run, not persisted)", async () => {
    const shot: ToolDefinition = {
      name: "shot",
      description: "screenshot",
      parametersJsonSchema: { type: "object", properties: {} },
      isReadOnly: true,
      call: async () => ({ content: "captured", isError: false, images: [{ data: "AAAA", mediaType: "image/png" }] }),
    };
    const { transport, requests } = fakeTransport([
      toolCallResult("c1", "shot", "{}"),
      textResult("I see a red button"),
    ]);
    const result = await runAgentLoop({
      transport,
      model: "test-model",
      systemPrompt: "sys",
      history,
      registry: new ToolRegistry([shot]),
    });
    // Turn 2's request carries the image as an image_url content part.
    const turn2 = requests[1]?.messages ?? [];
    const imgMsg = turn2.find((m) => m.role === "user" && Array.isArray(m.content));
    const parts = (imgMsg as { content: Array<{ type: string; image_url?: { url: string } }> } | undefined)?.content;
    expect(parts?.find((p) => p.type === "image_url")?.image_url?.url).toContain("data:image/png;base64,AAAA");
    // The multimodal message is in-run only — the persisted transcript stays assistant/tool/assistant (no base64 bloat).
    expect(result.produced.map((m) => m.role)).toEqual(["assistant", "tool", "assistant"]);
    expect(result.content).toBe("I see a red button");
  });

  it("gates write tools through the permit hook and auto-allows read-only tools", async () => {
    const writeCall = vi.fn(async () => ({ content: "wrote", isError: false }));
    const readCall = vi.fn(async () => ({ content: "read", isError: false }));
    const writeTool: ToolDefinition = {
      name: "do_write",
      description: "write",
      parametersJsonSchema: { type: "object", properties: {} },
      isReadOnly: false,
      call: writeCall,
    };
    const readTool: ToolDefinition = {
      name: "do_read",
      description: "read",
      parametersJsonSchema: { type: "object", properties: {} },
      isReadOnly: true,
      call: readCall,
    };
    const permit = vi.fn(
      async (req: PermissionRequest): Promise<PermissionDecision> => (req.name === "do_write" ? "deny" : "allow"),
    );
    // One turn, two tool calls (a write + a read); permit denies the write.
    const { transport } = fakeTransport([
      toolCallsResult([
        { id: "w", name: "do_write", args: "{}" },
        { id: "r", name: "do_read", args: "{}" },
      ]),
      textResult("done"),
    ]);
    const events: AgentEvent[] = [];
    const result = await runAgentLoop({
      transport,
      model: "test-model",
      systemPrompt: "sys",
      history,
      registry: new ToolRegistry([writeTool, readTool]),
      permit,
      onEvent: (e) => events.push(e),
    });
    expect(writeCall).not.toHaveBeenCalled(); // denied
    expect(readCall).toHaveBeenCalledOnce(); // read-only → auto-allowed
    expect(permit).toHaveBeenCalledOnce(); // consulted only for the write tool
    expect(events.filter((e) => e.type === "permission")).toEqual([
      { type: "permission", name: "do_write", decision: "deny" },
    ]);
    expect(result.toolCalls.find((t) => t.name === "do_write")?.ok).toBe(false);
  });

  it("dispatches multiple tool calls concurrently but appends results in call order", async () => {
    const finished: string[] = [];
    const slow: ToolDefinition = {
      name: "slow",
      description: "slow",
      parametersJsonSchema: { type: "object", properties: {} },
      isReadOnly: true,
      call: async () => {
        await new Promise((r) => setTimeout(r, 10));
        finished.push("slow");
        return { content: "slow-done", isError: false };
      },
    };
    const fast: ToolDefinition = {
      name: "fast",
      description: "fast",
      parametersJsonSchema: { type: "object", properties: {} },
      isReadOnly: true,
      call: async () => {
        finished.push("fast");
        return { content: "fast-done", isError: false };
      },
    };
    const { transport } = fakeTransport([
      toolCallsResult([
        { id: "s", name: "slow", args: "{}" },
        { id: "f", name: "fast", args: "{}" },
      ]),
      textResult("done"),
    ]);
    const result = await runAgentLoop({
      transport,
      model: "test-model",
      systemPrompt: "sys",
      history,
      registry: new ToolRegistry([slow, fast]),
    });
    // Concurrency: the fast tool completed before the slow one (sequential would be ["slow","fast"]).
    expect(finished).toEqual(["fast", "slow"]);
    // But the transcript preserves CALL order — slow's result precedes fast's (pairing must stay ordered).
    const toolContents = result.produced
      .filter((m) => m.role === "tool")
      .map((m) => (m as { content: string }).content);
    expect(toolContents).toEqual(["slow-done", "fast-done"]);
  });

  it("delegates to a sub-agent via spawn_agent and folds back its summary", async () => {
    // create() calls in order: (0) parent → spawn_agent tool call; (1) nested sub-agent → text summary; (2) parent → text.
    const { transport } = fakeTransport([
      toolCallResult("s1", "spawn_agent", JSON.stringify({ task: "research the failures" })),
      textResult("SUB: found 3 failures"),
      textResult("done — the sub-agent found 3 failures"),
    ]);
    const result = await runAgentLoop({
      transport,
      model: "test-model",
      systemPrompt: "sys",
      history,
      registry: new ToolRegistry([]),
    });
    expect(result.content).toBe("done — the sub-agent found 3 failures");
    // The spawn tool result carried the sub-agent's final summary back to the parent.
    const spawnResult = result.produced.find((m) => m.role === "tool");
    expect((spawnResult as { content: string } | undefined)?.content).toContain("SUB: found 3 failures");
    expect(result.toolCalls).toEqual([{ name: "spawn_agent", ok: true }]);
  });

  it("blocks write tools in plan mode until present_plan is approved", async () => {
    const writeCall = vi.fn(async () => ({ content: "wrote", isError: false }));
    const writeTool: ToolDefinition = {
      name: "do_write",
      description: "write",
      parametersJsonSchema: { type: "object", properties: {} },
      isReadOnly: false,
      call: writeCall,
    };
    const onPlan = vi.fn(async () => true);
    const { transport } = fakeTransport([
      toolCallResult("w1", "do_write", "{}"), // turn 1 — blocked (plan mode)
      toolCallResult("p1", "present_plan", JSON.stringify({ plan: "1. do the thing" })), // turn 2 — approved
      toolCallResult("w2", "do_write", "{}"), // turn 3 — now allowed
      textResult("done"), // turn 4
    ]);
    const result = await runAgentLoop({
      transport,
      model: "test-model",
      systemPrompt: "sys",
      history,
      registry: new ToolRegistry([writeTool]),
      planMode: true,
      onPlan,
    });
    expect(writeCall).toHaveBeenCalledOnce(); // only the post-approval write ran
    expect(onPlan).toHaveBeenCalledWith("1. do the thing");
    expect(result.content).toBe("done");
    const toolResults = result.produced.filter((m) => m.role === "tool").map((m) => (m as { content: string }).content);
    expect(toolResults[0]).toContain("In plan mode"); // the first write was blocked
  });

  it("stops with no_progress when the model repeats the identical tool-call batch too many turns", async () => {
    const noop: ToolDefinition = {
      name: "noop",
      description: "noop",
      parametersJsonSchema: { type: "object", properties: {} },
      isReadOnly: true,
      call: async () => ({ content: "ok", isError: false }),
    };
    // The model asks for the exact same tool call three turns running — it saw the same result twice and repeated.
    const { transport } = fakeTransport([
      toolCallResult("c1", "noop", "{}"),
      toolCallResult("c2", "noop", "{}"),
      toolCallResult("c3", "noop", "{}"),
      textResult("unreached"),
    ]);
    const result = await runAgentLoop({
      transport,
      model: "test-model",
      systemPrompt: "sys",
      history,
      registry: new ToolRegistry([noop]),
    });
    expect(result.stopReason).toBe("no_progress");
    expect(result.turns).toBe(3);
  });

  it("recovers from a context-overflow (413) by compacting once and retrying the same turn", async () => {
    // A long history with big old tool results so rung-1 microcompact can reclaim tokens on the reactive path.
    const big = "R".repeat(600);
    const longHistory: ChatMessage[] = [{ role: "user", content: "goal" }];
    for (let i = 0; i < 5; i++) {
      longHistory.push({
        role: "assistant",
        content: null,
        tool_calls: [{ id: `h${i}`, type: "function", function: { name: "noop", arguments: "{}" } }],
      });
      longHistory.push({ role: "tool", tool_call_id: `h${i}`, content: big });
    }
    longHistory.push({ role: "user", content: "continue" });

    let calls = 0;
    const overflowThenOk: LlmTransport = {
      provider: "fake",
      stream: async () => {
        calls += 1;
        if (calls === 1) throw new Error("prompt is too long: 250000 tokens > 200000 maximum context length");
        return { content: "recovered", toolCalls: [], finishReason: "stop", usage: usage7 };
      },
    };
    const events: AgentEvent[] = [];
    const result = await runAgentLoop({
      transport: overflowThenOk,
      model: "test-model",
      systemPrompt: "sys",
      history: longHistory,
      registry: new ToolRegistry([]),
      summarize: async () => "digest",
      onEvent: (e) => events.push(e),
    });
    // The overflow did not crash the run — a compaction fired and the retried call succeeded.
    expect(result.stopReason).toBe("end_turn");
    expect(result.content).toBe("recovered");
    expect(events.some((e) => e.type === "compaction")).toBe(true);
  });

  it("switches to the fallback model after the primary keeps failing transiently", async () => {
    const primary: LlmTransport = {
      provider: "primary",
      stream: async () => {
        throw Object.assign(new Error("overloaded"), { status: 529 });
      },
    };
    const fallbackTransport: LlmTransport = {
      provider: "fallback",
      stream: async () => ({ content: "answered by fallback", toolCalls: [], finishReason: "stop", usage: usage7 }),
    };
    const events: AgentEvent[] = [];
    const result = await runAgentLoop({
      transport: primary,
      model: "big-model",
      systemPrompt: "sys",
      history,
      registry: new ToolRegistry([]),
      maxRetries: 0, // switch to the fallback after the first failed attempt
      fallback: { transport: fallbackTransport, model: "small-model" },
      onEvent: (e) => events.push(e),
    });
    expect(result.stopReason).toBe("end_turn");
    expect(result.content).toBe("answered by fallback");
    expect(events).toContainEqual({ type: "fallback", from: "big-model", to: "small-model" });
  });

  it("injects host-queued user messages between turns via drainInput (mid-run steering)", async () => {
    const noop: ToolDefinition = {
      name: "noop",
      description: "noop",
      parametersJsonSchema: { type: "object", properties: {} },
      isReadOnly: true,
      call: async () => ({ content: "ok", isError: false }),
    };
    let drainCalls = 0;
    const drainInput = (): ChatMessage[] => {
      drainCalls += 1;
      // Deliver a steering message only at the start of the 2nd turn (turn boundary, context balanced).
      return drainCalls === 2 ? [{ role: "user", content: "also handle X" }] : [];
    };
    const { transport, requests } = fakeTransport([
      toolCallResult("c1", "noop", "{}"), // turn 1 keeps the loop going
      textResult("done, including X"), // turn 2, after the injected message
    ]);
    const result = await runAgentLoop({
      transport,
      model: "test-model",
      systemPrompt: "sys",
      history,
      registry: new ToolRegistry([noop]),
      drainInput,
    });
    // The injected message is persisted (produced) and present in turn 2's outbound request.
    expect(result.produced.some((m) => m.role === "user" && m.content === "also handle X")).toBe(true);
    const turn2 = requests[1]?.messages ?? [];
    expect(turn2.some((m) => m.role === "user" && m.content === "also handle X")).toBe(true);
    expect(result.content).toBe("done, including X");
  });

  it("gives a sub-agent a READ-ONLY view of the tools (it cannot invoke the parent's write tools)", async () => {
    const writeCall = vi.fn(async () => ({ content: "wrote", isError: false }));
    const writeTool: ToolDefinition = {
      name: "do_write",
      description: "write",
      parametersJsonSchema: { type: "object", properties: {} },
      isReadOnly: false,
      call: writeCall,
    };
    // Sequence across parent + nested: (0) parent spawns; (1) sub-agent tries do_write; (2) sub-agent summary; (3) parent text.
    const { transport } = fakeTransport([
      toolCallResult("s1", "spawn_agent", JSON.stringify({ task: "try to write" })),
      toolCallResult("w1", "do_write", "{}"),
      textResult("SUB: could not write"),
      textResult("done"),
    ]);
    const result = await runAgentLoop({
      transport,
      model: "test-model",
      systemPrompt: "sys",
      history,
      registry: new ToolRegistry([writeTool]),
    });
    expect(writeCall).not.toHaveBeenCalled(); // the write tool is not in the sub-agent's read-only registry
    expect(result.content).toBe("done");
  });

  it("stops with aborted when the signal is already aborted", async () => {
    const { transport } = fakeTransport([textResult("unused")]);
    const result = await runAgentLoop({
      transport,
      model: "test-model",
      systemPrompt: "sys",
      history,
      registry: new ToolRegistry([]),
      signal: AbortSignal.abort(),
    });
    expect(result.stopReason).toBe("aborted");
    expect(result.turns).toBe(0);
  });
});
