import type { LlmTransport, StreamRequest, StreamResult } from "@everdict/llm";
import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../messages.js";
import type { PermissionDecision, PermissionRequest, ToolDefinition } from "../tools/definition.js";
import { ToolRegistry } from "../tools/registry.js";
import { type AgentEvent, retryDelayMs, runAgentLoop } from "./loop.js";

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

  it("fires onUsage with each turn's token usage (the host meters LLM cost from it)", async () => {
    const { transport } = fakeTransport([textResult("Hi there")]);
    const seen: { inputTokens: number; outputTokens: number }[] = [];
    await runAgentLoop({
      transport,
      model: "test-model",
      systemPrompt: "s",
      history,
      registry: new ToolRegistry([]),
      onUsage: (u) => seen.push({ inputTokens: u.inputTokens, outputTokens: u.outputTokens }),
    });
    expect(seen).toEqual([{ inputTokens: 7, outputTokens: 0 }]); // usage7 from the fake transport
  });

  it("emits reasoning_delta and attaches the turn's reasoning (text + blocks) to the assistant message", async () => {
    const events: AgentEvent[] = [];
    const persisted: ChatMessage[] = [];
    const blocks = [{ type: "thinking", thinking: "weigh it", signature: "sig" }];
    const transport: LlmTransport = {
      provider: "fake",
      stream: async (req) => {
        req.onReasoningDelta?.("weigh it");
        req.onContentDelta?.("Answer");
        return {
          content: "Answer",
          toolCalls: [],
          finishReason: "stop",
          usage: usage7,
          reasoning: "weigh it",
          reasoningBlocks: blocks,
        };
      },
    };
    await runAgentLoop({
      transport,
      model: "m",
      systemPrompt: "s",
      history,
      registry: new ToolRegistry([]),
      onEvent: (e) => events.push(e),
      onMessage: (m) => {
        persisted.push(m);
      },
    });
    expect(events).toContainEqual({ type: "reasoning_delta", delta: "weigh it" });
    const assistant = persisted.find((m) => m.role === "assistant");
    expect((assistant as { reasoning?: { text: string; blocks?: unknown[] } }).reasoning).toEqual({
      text: "weigh it",
      blocks,
    });
  });

  it("forwards the thinking budget to the transport request", async () => {
    const { transport, requests } = fakeTransport([textResult("hi")]);
    await runAgentLoop({
      transport,
      model: "m",
      systemPrompt: "s",
      history,
      registry: new ToolRegistry([]),
      thinking: { budgetTokens: 1500 },
    });
    expect(requests[0]?.thinking).toEqual({ budgetTokens: 1500 });
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

  it("keeps watching when the identical tool call keeps returning a changed result", async () => {
    let polls = 0;
    const getScorecard: ToolDefinition = {
      name: "get_scorecard",
      description: "scorecard status",
      parametersJsonSchema: { type: "object", properties: { id: { type: "string" } } },
      isReadOnly: true,
      // The world moves between identical questions — the answer is never the same twice.
      call: async () => ({ content: `running ${++polls * 8}/50 cases`, isError: false }),
    };
    // Watching an async job re-sends the same arguments by design: four identical batches, each answered differently.
    const { transport } = fakeTransport([
      toolCallResult("c1", "get_scorecard", '{"id":"sc1"}'),
      toolCallResult("c2", "get_scorecard", '{"id":"sc1"}'),
      toolCallResult("c3", "get_scorecard", '{"id":"sc1"}'),
      toolCallResult("c4", "get_scorecard", '{"id":"sc1"}'),
      textResult("the batch finished"),
    ]);
    const result = await runAgentLoop({
      transport,
      model: "test-model",
      systemPrompt: "sys",
      history,
      registry: new ToolRegistry([getScorecard]),
    });
    expect(result.stopReason).toBe("end_turn");
    expect(result.content).toBe("the batch finished");
    expect(polls).toBe(4);
  });

  it("parks the run with stopReason waiting when the agent calls wait_for", async () => {
    const { transport } = fakeTransport([
      toolCallResult(
        "c1",
        "wait_for",
        JSON.stringify({
          kinds: ["scorecard.completed"],
          filters: [{ field: "id", op: "eq", value: "sc1" }],
          note: "watching scorecard sc1 to report its pass rate",
          timeout_seconds: 900,
        }),
      ),
      textResult("unreached — the run ended at the wait"),
    ]);
    const result = await runAgentLoop({
      transport,
      model: "test-model",
      systemPrompt: "sys",
      history,
      registry: new ToolRegistry([]),
      waitFor: { kinds: ["scorecard.completed", "scorecard.failed"] },
    });
    // Waiting is NOT end_turn: the work continues and the agent still owes an answer.
    expect(result.stopReason).toBe("waiting");
    expect(result.waitRequest).toEqual({
      kinds: ["scorecard.completed"],
      filters: [{ field: "id", op: "eq", value: "sc1" }],
      note: "watching scorecard sc1 to report its pass rate",
      timeoutSeconds: 900,
    });
    // The transcript ends balanced — the wait_for call has its tool result, so the conversation replays verbatim.
    const last = result.produced[result.produced.length - 1];
    expect(last?.role).toBe("tool");
  });

  it("rejects a wait on an event kind the host cannot resume on, and keeps going", async () => {
    const { transport } = fakeTransport([
      toolCallResult("c1", "wait_for", JSON.stringify({ kinds: ["invented.kind"], note: "watching" })),
      textResult("picked a different approach"),
    ]);
    const result = await runAgentLoop({
      transport,
      model: "test-model",
      systemPrompt: "sys",
      history,
      registry: new ToolRegistry([]),
      waitFor: { kinds: ["scorecard.completed"] },
    });
    expect(result.stopReason).toBe("end_turn");
    expect(result.waitRequest).toBeUndefined();
    const toolText = result.produced.filter((m) => m.role === "tool").map((m) => (m as { content: string }).content);
    expect(toolText[0]).toContain("is not a waitable event kind");
  });

  it("does not offer wait_for when the host cannot resume conversations", async () => {
    const { transport, requests } = fakeTransport([textResult("done")]);
    await runAgentLoop({
      transport,
      model: "test-model",
      systemPrompt: "sys",
      history,
      registry: new ToolRegistry([]),
    });
    const offered = (requests[0]?.tools ?? []).map((t) => t.name);
    expect(offered).not.toContain("wait_for");
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

  it("computes retry delays: server Retry-After wins, else exponential backoff + jitter capped at 32s", () => {
    // Server pacing is honored verbatim (capped at 1h so a pathological header can't park the loop unbounded)
    expect(retryDelayMs(0, 7_000)).toBe(7_000);
    expect(retryDelayMs(5, 10 * 60 * 60_000)).toBe(60 * 60_000);
    // No hint → exponential base with up-to-25% jitter
    expect(retryDelayMs(0, undefined, undefined, () => 0)).toBe(500);
    expect(retryDelayMs(3, undefined, undefined, () => 0)).toBe(4_000);
    expect(retryDelayMs(3, undefined, undefined, () => 0.999)).toBeLessThan(4_000 * 1.25 + 1);
    // The cap holds for deep attempts
    expect(retryDelayMs(20, undefined, undefined, () => 0)).toBe(32_000);
  });

  it("honors the server's Retry-After pacing surfaced by the transport (extra.retryAfterMs)", async () => {
    let calls = 0;
    const rateLimitedThenOk: LlmTransport = {
      provider: "fake",
      stream: async () => {
        calls += 1;
        if (calls === 1)
          throw Object.assign(new Error("model 429: rate limited"), { extra: { status: 429, retryAfterMs: 5 } });
        return { content: "recovered", toolCalls: [], finishReason: "stop", usage: usage7 };
      },
    };
    const events: AgentEvent[] = [];
    const result = await runAgentLoop({
      transport: rateLimitedThenOk,
      model: "test-model",
      systemPrompt: "sys",
      history,
      registry: new ToolRegistry([]),
      onEvent: (e) => events.push(e),
    });
    expect(result.content).toBe("recovered");
    // The wait used the server's own pacing, not the computed backoff — and was surfaced as a retry event.
    expect(events).toContainEqual({ type: "retry", attempt: 1, delayMs: 5 });
  });

  it("does NOT retry a provider 400 (the upstream status in extra.status is authoritative, not our 502 mapping)", async () => {
    let calls = 0;
    const badRequest: LlmTransport = {
      provider: "fake",
      stream: async () => {
        calls += 1;
        // The shape the AnthropicTransport throws: an UpstreamError whose OWN status is 502 (our HTTP mapping)
        // but whose extra.status carries the provider's 400 — retrying an invalid request can never help.
        throw Object.assign(new Error("model 400: invalid_request_error"), {
          status: 502,
          extra: { status: 400 },
        });
      },
    };
    await expect(
      runAgentLoop({
        transport: badRequest,
        model: "test-model",
        systemPrompt: "sys",
        history,
        registry: new ToolRegistry([]),
      }),
    ).rejects.toThrow(/model provider call failed/i);
    expect(calls).toBe(1); // one attempt, no retries burned on a permanent error
  });

  it("reports WHY the provider call failed instead of a bare 'the model provider call failed'", async () => {
    const quotaGone: LlmTransport = {
      provider: "fake",
      stream: async () => {
        throw Object.assign(
          new Error('model 429: {"error":{"type":"usage_limit_reached","message":"The usage limit has been reached"}}'),
          { extra: { status: 429 } },
        );
      },
    };
    const err = await runAgentLoop({
      transport: quotaGone,
      model: "test-model",
      systemPrompt: "sys",
      history,
      registry: new ToolRegistry([]),
      maxRetries: 0,
    })
      .then(() => null)
      .catch((e: unknown) => e);
    // The host persists this message into the transcript — it is the member's ONLY account of the failure, so the
    // provider's own reason (and the upstream status) must survive the remap.
    expect((err as Error).message).toContain("usage_limit_reached");
    expect((err as { extra?: unknown }).extra).toMatchObject({ status: 429 });
  });

  it("fails an attended turn fast when the server's retry pacing is longer than a person can wait", async () => {
    let calls = 0;
    const quotaResetsInAnHour: LlmTransport = {
      provider: "fake",
      stream: async () => {
        calls += 1;
        // A plan quota answers with its own reset — retrying (or parking on it) is not recovery, it is a hang.
        throw Object.assign(new Error("model 429: usage limit reached"), {
          extra: { status: 429, retryAfterMs: 60 * 60_000 },
        });
      },
    };
    await expect(
      runAgentLoop({
        transport: quotaResetsInAnHour,
        model: "test-model",
        systemPrompt: "sys",
        history,
        registry: new ToolRegistry([]),
      }),
    ).rejects.toThrow(/usage limit reached/i);
    expect(calls).toBe(1); // no retry slept for an hour, and no budget burned pretending it might clear
  });

  it("waits out capacity errors indefinitely under persistentRetry instead of exhausting the budget", async () => {
    let calls = 0;
    const overloadedTwiceThenOk: LlmTransport = {
      provider: "fake",
      stream: async () => {
        calls += 1;
        if (calls <= 2) throw Object.assign(new Error("overloaded"), { extra: { status: 529, retryAfterMs: 1 } });
        return { content: "survived", toolCalls: [], finishReason: "stop", usage: usage7 };
      },
    };
    const events: AgentEvent[] = [];
    const result = await runAgentLoop({
      transport: overloadedTwiceThenOk,
      model: "test-model",
      systemPrompt: "sys",
      history,
      registry: new ToolRegistry([]),
      maxRetries: 0, // without persistentRetry these two failures would end the run
      persistentRetry: true,
      onEvent: (e) => events.push(e),
    });
    expect(result.content).toBe("survived");
    expect(events.filter((e) => e.type === "retry" && e.persistent === true)).toHaveLength(2);
  });

  it("runs write tools serially (in call order) while read-only tools stay concurrent", async () => {
    // Given two write tools that record overlap: a slow one requested FIRST and a fast one second
    let active = 0;
    let overlapped = false;
    const writeTool = (name: string, delayMs: number): ToolDefinition => ({
      name,
      description: name,
      parametersJsonSchema: { type: "object", properties: {} },
      isReadOnly: false,
      call: async () => {
        active += 1;
        if (active > 1) overlapped = true;
        await new Promise((r) => setTimeout(r, delayMs));
        active -= 1;
        return { content: `${name}-done`, isError: false };
      },
    });
    const { transport } = fakeTransport([
      toolCallsResult([
        { id: "w1", name: "write_slow", args: "{}" },
        { id: "w2", name: "write_fast", args: "{}" },
      ]),
      textResult("done"),
    ]);
    const result = await runAgentLoop({
      transport,
      model: "test-model",
      systemPrompt: "sys",
      history,
      registry: new ToolRegistry([writeTool("write_slow", 10), writeTool("write_fast", 0)]),
    });
    // Then the writes never ran at the same time (a mutation race), and pairing order is preserved
    expect(overlapped).toBe(false);
    const toolContents = result.produced
      .filter((m) => m.role === "tool")
      .map((m) => (m as { content: string }).content);
    expect(toolContents).toEqual(["write_slow-done", "write_fast-done"]);
  });

  it("emits a truncated event when the turn hits the output-token cap", async () => {
    const { transport } = fakeTransport([
      { content: "cut off mid-", toolCalls: [], finishReason: "max_tokens", usage: usage7 },
    ]);
    const events: AgentEvent[] = [];
    await runAgentLoop({
      transport,
      model: "test-model",
      systemPrompt: "sys",
      history,
      registry: new ToolRegistry([]),
      onEvent: (e) => events.push(e),
    });
    expect(events).toContainEqual({ type: "truncated", finishReason: "max_tokens" });
  });

  it("forwards outputTokens to the transport as the per-call max_tokens", async () => {
    const { transport, requests } = fakeTransport([textResult("ok")]);
    await runAgentLoop({
      transport,
      model: "test-model",
      systemPrompt: "sys",
      history,
      registry: new ToolRegistry([]),
      outputTokens: 16_000,
    });
    expect(requests[0]?.maxTokens).toBe(16_000);
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

  it("aborts a tool that outruns toolTimeoutMs and returns an error the model can move past", async () => {
    const hang: ToolDefinition = {
      name: "hang",
      description: "never resolves",
      parametersJsonSchema: { type: "object", properties: {} },
      isReadOnly: true,
      call: () => new Promise<{ content: string; isError: boolean }>(() => {}), // never settles
    };
    const { transport } = fakeTransport([toolCallResult("h1", "hang", "{}"), textResult("moved on")]);
    const result = await runAgentLoop({
      transport,
      model: "test-model",
      systemPrompt: "sys",
      history,
      registry: new ToolRegistry([hang]),
      toolTimeoutMs: 15,
    });
    expect(result.stopReason).toBe("end_turn");
    expect(result.content).toBe("moved on");
    const toolMsg = result.produced.find((m) => m.role === "tool") as { content: string } | undefined;
    expect(toolMsg?.content).toContain("deadline");
    expect(result.toolCalls).toEqual([{ name: "hang", ok: false }]);
  });

  it("runs spawn_agent sub-agents on the configured (cheaper) subagentModel", async () => {
    const parent = fakeTransport([
      toolCallResult("s1", "spawn_agent", JSON.stringify({ task: "research" })),
      textResult("done"),
    ]);
    const sub = fakeTransport([textResult("SUB summary")]);
    const result = await runAgentLoop({
      transport: parent.transport,
      model: "big-model",
      systemPrompt: "sys",
      history,
      registry: new ToolRegistry([]),
      subagentModel: { transport: sub.transport, model: "cheap-model" },
    });
    expect(result.content).toBe("done");
    // The sub-agent's turn went to the subagent transport/model, not the parent's.
    expect(sub.requests).toHaveLength(1);
    expect(sub.requests[0]?.model).toBe("cheap-model");
    const spawnResult = result.produced.find((m) => m.role === "tool") as { content: string } | undefined;
    expect(spawnResult?.content).toContain("SUB summary");
  });

  it("runs a background (fire-and-forget) sub-agent with overlap and folds its result into a later turn", async () => {
    const parent = fakeTransport([
      toolCallResult("s1", "spawn_agent", JSON.stringify({ task: "research", run_in_background: true })),
      textResult("FINAL"),
    ]);
    const sub = fakeTransport([textResult("BACKGROUND FINDING")]);
    const events: AgentEvent[] = [];
    const result = await runAgentLoop({
      transport: parent.transport,
      model: "m",
      systemPrompt: "sys",
      history,
      registry: new ToolRegistry([]),
      subagentModel: { transport: sub.transport, model: "cheap" },
      onEvent: (e) => events.push(e),
    });
    expect(result.stopReason).toBe("end_turn");
    expect(result.content).toBe("FINAL");
    // spawn returned immediately (a launch notice, not the summary — that's the fire-and-forget contract).
    const launched = result.produced.find((m) => m.role === "tool") as { content: string } | undefined;
    expect(launched?.content).toContain("launched in the background");
    // the background finding was folded back in as a follow-up user turn (delivered, not lost).
    expect(
      result.produced.some(
        (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("BACKGROUND FINDING"),
      ),
    ).toBe(true);
    // lifecycle events fire (launched then done).
    const phases = events.filter((e) => e.type === "subagent").map((e) => (e as { phase: string }).phase);
    expect(phases).toEqual(["launched", "done"]);
  });

  it("routes spawn_agent to a selected subagent_type (its role instructions + model tier)", async () => {
    const parent = fakeTransport([
      toolCallResult("s1", "spawn_agent", JSON.stringify({ task: "find X", subagent_type: "explore" })),
      textResult("done"),
    ]);
    const explore = fakeTransport([textResult("EXPLORED")]);
    const result = await runAgentLoop({
      transport: parent.transport,
      model: "big-model",
      systemPrompt: "sys",
      history,
      registry: new ToolRegistry([]),
      subagentTypes: [
        {
          name: "explore",
          description: "fast broad read-only search",
          instructions: "Search broadly and fast",
          model: { transport: explore.transport, model: "explore-model" },
        },
      ],
    });
    expect(result.content).toBe("done");
    // The sub-agent ran on the type's model tier with the type's role woven into its system prompt.
    expect(explore.requests).toHaveLength(1);
    expect(explore.requests[0]?.model).toBe("explore-model");
    expect(explore.requests[0]?.system).toContain("Search broadly and fast");
    const spawnResult = result.produced.find((m) => m.role === "tool") as { content: string } | undefined;
    expect(spawnResult?.content).toContain("EXPLORED");
  });

  it("delivers a parent send_message to a running background sub-agent (two-way collaboration)", async () => {
    let subEnteredWait: () => void = () => {};
    const subInWait = new Promise<void>((r) => {
      subEnteredWait = r;
    });
    let releaseWait: () => void = () => {};
    const waitReleased = new Promise<void>((r) => {
      releaseWait = r;
    });
    // A read-only tool the sub-agent parks in until the test releases it — a deterministic window for the parent to send.
    const wait: ToolDefinition = {
      name: "wait",
      description: "park until released",
      parametersJsonSchema: { type: "object", properties: {} },
      isReadOnly: true,
      call: async () => {
        subEnteredWait();
        await waitReleased;
        return { content: "resumed", isError: false };
      },
    };
    const parent = fakeTransport([
      toolCallResult("s1", "spawn_agent", JSON.stringify({ task: "research", run_in_background: true })),
      toolCallResult("m1", "send_message", JSON.stringify({ to: "bg-1", message: "STEER-THE-SUB" })),
      textResult("done"),
    ]);
    // Sub: turn 1 parks in wait; turn 2 (after release) drains the delivered message, then finishes.
    const sub = fakeTransport([toolCallResult("w1", "wait", "{}"), textResult("sub done")]);

    const runP = runAgentLoop({
      transport: parent.transport,
      model: "m",
      systemPrompt: "sys",
      history,
      registry: new ToolRegistry([wait]),
      subagentModel: { transport: sub.transport, model: "cheap" },
    });

    await subInWait; // the sub is parked in its wait tool
    // Let the parent run turn 2 (send_message) + turn 3 (end_turn → awaits the sub): the message is now in bg-1's mailbox.
    await new Promise((r) => setTimeout(r, 0));
    releaseWait(); // the sub resumes → a later turn drains the delivered message

    const result = await runP;
    expect(result.content).toBe("done");
    // The parent's message reached the running sub-agent (attributed), in some turn's request.
    const sawMessage = sub.requests.some((req) =>
      (req.messages ?? []).some(
        (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("STEER-THE-SUB"),
      ),
    );
    expect(sawMessage).toBe(true);
  });

  it("routes send_message to the host seam for a recipient that is not a background sub-agent (S2 generalization)", async () => {
    const routed: { to: string; message: string }[] = [];
    const { transport } = fakeTransport([
      toolCallResult("m1", "send_message", JSON.stringify({ to: "teammate-researcher", message: "please dig in" })),
      textResult("sent"),
    ]);
    const result = await runAgentLoop({
      transport,
      model: "m",
      systemPrompt: "sys",
      history,
      registry: new ToolRegistry([]),
      sendMessage: (to, message) => {
        routed.push({ to, message });
        return { ok: true };
      },
    });
    expect(result.content).toBe("sent");
    // No such background sub-agent → the kernel fell through to the host routing seam.
    expect(routed).toEqual([{ to: "teammate-researcher", message: "please dig in" }]);
    const toolMsg = result.produced.find((m) => m.role === "tool") as { content: string } | undefined;
    expect(toolMsg?.content).toContain("Delivered to teammate-researcher");
  });

  it("routes spawn_teammate to the host callback when wired (autonomous collaboration)", async () => {
    const spawned: { name: string; task: string }[] = [];
    const { transport } = fakeTransport([
      toolCallResult("t1", "spawn_teammate", JSON.stringify({ name: "researcher", task: "watch regressions" })),
      textResult("teammate is on it"),
    ]);
    const result = await runAgentLoop({
      transport,
      model: "m",
      systemPrompt: "sys",
      history,
      registry: new ToolRegistry([]),
      spawnTeammate: async (name, task) => {
        spawned.push({ name, task });
        return { id: "tm-1" };
      },
    });
    expect(result.content).toBe("teammate is on it");
    expect(spawned).toEqual([{ name: "researcher", task: "watch regressions" }]);
    const toolMsg = result.produced.find((m) => m.role === "tool") as { content: string } | undefined;
    expect(toolMsg?.content).toContain("tm-1");
  });

  it("gates spawn_teammate behind the permission hook — a denied spawn never reaches the host callback", async () => {
    // Spawning delegates standing WRITE authority (the host mints the teammate an execution token), so the tool is
    // NOT read-only: the permit hook decides. Pre-fix, isReadOnly:true skipped the gate entirely.
    const spawned: string[] = [];
    const { transport } = fakeTransport([
      toolCallResult("t1", "spawn_teammate", JSON.stringify({ name: "rogue", task: "act freely" })),
      textResult("understood"),
    ]);
    const result = await runAgentLoop({
      transport,
      model: "m",
      systemPrompt: "sys",
      history,
      registry: new ToolRegistry([]),
      spawnTeammate: async (name) => {
        spawned.push(name);
        return { id: "tm-x" };
      },
      permit: async () => "deny" as const,
    });
    expect(spawned).toEqual([]); // the delegation was refused before the host created anything
    expect(result.content).toBe("understood");
  });

  it("exposes list_teammates when the host wires it (team discovery for coordination)", async () => {
    const { transport } = fakeTransport([toolCallResult("l1", "list_teammates", "{}"), textResult("I see the team")]);
    const result = await runAgentLoop({
      transport,
      model: "m",
      systemPrompt: "sys",
      history,
      registry: new ToolRegistry([]),
      listTeammates: async () => [{ id: "tm-1", name: "researcher", watch: ["scorecard.regressed"] }],
    });
    expect(result.content).toBe("I see the team");
    const toolMsg = result.produced.find((m) => m.role === "tool") as { content: string } | undefined;
    expect(toolMsg?.content).toContain("tm-1");
    expect(toolMsg?.content).toContain("researcher");
    expect(toolMsg?.content).toContain("scorecard.regressed");
  });

  it("ends the run with the value submitted via structured_output (outputSchema)", async () => {
    const { transport } = fakeTransport([toolCallResult("s1", "structured_output", '{"verdict":"pass","score":0.9}')]);
    const result = await runAgentLoop({
      transport,
      model: "test-model",
      systemPrompt: "sys",
      history,
      registry: new ToolRegistry([]),
      outputSchema: {
        type: "object",
        properties: { verdict: { type: "string" }, score: { type: "number" } },
        required: ["verdict"],
      },
    });
    expect(result.stopReason).toBe("end_turn");
    expect(result.structuredOutput).toEqual({ verdict: "pass", score: 0.9 });
    // The submission is a normal tool exchange — the transcript stays balanced.
    expect(result.toolCalls).toEqual([{ name: "structured_output", ok: true }]);
  });

  it("nudges ONCE when the model finishes without submitting structured output, then accepts", async () => {
    const { transport, requests } = fakeTransport([
      textResult("here is my answer in prose"), // finishes without submitting → nudged
      toolCallResult("s1", "structured_output", '{"verdict":"fail"}'),
    ]);
    const result = await runAgentLoop({
      transport,
      model: "test-model",
      systemPrompt: "sys",
      history,
      registry: new ToolRegistry([]),
      outputSchema: { type: "object", properties: { verdict: { type: "string" } } },
    });
    expect(result.structuredOutput).toEqual({ verdict: "fail" });
    // The second call saw the nudge as a user turn.
    const secondMessages = requests[1]?.messages ?? [];
    const last = secondMessages[secondMessages.length - 1] as { role: string; content: string };
    expect(last.role).toBe("user");
    expect(last.content).toContain("structured_output");
  });

  it("a run without outputSchema has no structured_output tool and no structuredOutput", async () => {
    const { transport, requests } = fakeTransport([textResult("done")]);
    const result = await runAgentLoop({
      transport,
      model: "test-model",
      systemPrompt: "sys",
      history,
      registry: new ToolRegistry([]),
    });
    expect(result.structuredOutput).toBeUndefined();
    expect((requests[0]?.tools ?? []).map((t) => t.name)).not.toContain("structured_output");
  });

  it("soft interrupt mid model call redirects: the stream is cut, queued input absorbed, the turn continues", async () => {
    let interrupt: (() => void) | undefined;
    const queue: ChatMessage[] = [];
    let calls = 0;
    const requests: StreamRequest[] = [];
    const transport: LlmTransport = {
      provider: "fake",
      stream: (req) => {
        calls += 1;
        requests.push(req);
        if (calls === 1) {
          // Hangs until aborted — the shape of a long in-flight stream the user wants to cut.
          return new Promise((_resolve, reject) => {
            req.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        }
        return Promise.resolve({ content: "doing B instead", toolCalls: [], finishReason: "stop", usage: usage7 });
      },
    };
    const run = runAgentLoop({
      transport,
      model: "m",
      systemPrompt: "s",
      history,
      registry: new ToolRegistry([]),
      onInterruptReady: (i) => {
        interrupt = i;
      },
      drainInput: () => queue.splice(0),
    });
    await new Promise((r) => setTimeout(r, 10)); // let the first stream get in flight
    queue.push({ role: "user", content: "actually, do B instead" });
    interrupt?.();
    const result = await run;
    // The turn survived the cut and continued redirected.
    expect(result.stopReason).toBe("end_turn");
    expect(result.content).toBe("doing B instead");
    const second = requests[1]?.messages ?? [];
    expect(second.some((m) => m.role === "user" && m.content === "actually, do B instead")).toBe(true);
  });

  it("a bare soft interrupt (nothing queued) ends the run with stopReason interrupted", async () => {
    let interrupt: (() => void) | undefined;
    let calls = 0;
    const transport: LlmTransport = {
      provider: "fake",
      stream: (req) => {
        calls += 1;
        return new Promise((_resolve, reject) => {
          req.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    };
    const run = runAgentLoop({
      transport,
      model: "m",
      systemPrompt: "s",
      history,
      registry: new ToolRegistry([]),
      onInterruptReady: (i) => {
        interrupt = i;
      },
      drainInput: () => [],
    });
    await new Promise((r) => setTimeout(r, 10));
    interrupt?.();
    const result = await run;
    expect(result.stopReason).toBe("interrupted");
    expect(calls).toBe(1); // no blind re-call after the cut
  });

  it("a cancelled turn keeps the text it had already streamed as a real assistant turn", async () => {
    // Given: a stream that emits an answer's opening words, then hangs — the shape of a turn the member stops.
    const controller = new AbortController();
    const produced: ChatMessage[] = [];
    const transport: LlmTransport = {
      provider: "fake",
      stream: (req) =>
        new Promise((_resolve, reject) => {
          req.onContentDelta?.("Here is what I found so f");
          req.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    };
    const run = runAgentLoop({
      transport,
      model: "m",
      systemPrompt: "s",
      history,
      registry: new ToolRegistry([]),
      onMessage: (m) => {
        produced.push(m);
      },
      signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 10)); // let the deltas land before the stop

    // When: the member stops the whole turn.
    controller.abort();
    const result = await run;

    // Then: what they had already READ is a persisted assistant turn — the transcript has no hole where the
    // answer was, and the next turn does not append a user message straight after a user message.
    expect(result.stopReason).toBe("aborted");
    expect(produced).toEqual([{ role: "assistant", content: "Here is what I found so f" }]);
    expect(result.produced).toEqual(produced);
  });

  it("a redirected turn keeps the partial answer, so the model sees what it had already said", async () => {
    // Given: a first stream that says something, then hangs until interrupted.
    let interrupt: (() => void) | undefined;
    const queue: ChatMessage[] = [];
    const requests: StreamRequest[] = [];
    let calls = 0;
    const transport: LlmTransport = {
      provider: "fake",
      stream: (req) => {
        calls += 1;
        requests.push(req);
        if (calls === 1)
          return new Promise((_resolve, reject) => {
            req.onContentDelta?.("I'll start by reading the harness spec");
            req.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        return Promise.resolve({ content: "doing B instead", toolCalls: [], finishReason: "stop", usage: usage7 });
      },
    };
    const run = runAgentLoop({
      transport,
      model: "m",
      systemPrompt: "s",
      history,
      registry: new ToolRegistry([]),
      onInterruptReady: (i) => {
        interrupt = i;
      },
      drainInput: () => queue.splice(0),
    });
    await new Promise((r) => setTimeout(r, 10));

    // When: the member redirects mid-answer.
    queue.push({ role: "user", content: "actually, do B instead" });
    interrupt?.();
    await run;

    // Then: the redirected call replays the cut-off answer before the new instruction — the model is told what
    // it was in the middle of, instead of the transcript jumping from one user turn to the next.
    const second = requests[1]?.messages ?? [];
    const partial = second.findIndex(
      (m) => m.role === "assistant" && m.content === "I'll start by reading the harness spec",
    );
    const redirect = second.findIndex((m) => m.role === "user" && m.content === "actually, do B instead");
    expect(partial).toBeGreaterThanOrEqual(0);
    expect(redirect).toBeGreaterThan(partial);
  });

  it("soft interrupt mid tool batch closes the pairing with synthetic results and continues redirected", async () => {
    let interrupt: (() => void) | undefined;
    const queue: ChatMessage[] = [];
    const hang: ToolDefinition = {
      name: "hang",
      description: "never settles (a wedged MCP call)",
      parametersJsonSchema: { type: "object", properties: {} },
      isReadOnly: true,
      call: () => new Promise(() => {}),
    };
    const { transport } = fakeTransport([toolCallResult("t1", "hang", "{}"), textResult("resumed after redirect")]);
    const run = runAgentLoop({
      transport,
      model: "m",
      systemPrompt: "s",
      history,
      registry: new ToolRegistry([hang]),
      onInterruptReady: (i) => {
        interrupt = i;
      },
      drainInput: () => queue.splice(0),
    });
    await new Promise((r) => setTimeout(r, 10)); // let the tool get in flight
    queue.push({ role: "user", content: "skip that, summarize instead" });
    interrupt?.();
    const result = await run;
    expect(result.stopReason).toBe("end_turn");
    expect(result.content).toBe("resumed after redirect");
    // The wedged call was answered synthetically — pairing intact, outcome flagged unknown.
    const toolMessages = result.produced.filter((m) => m.role === "tool") as { content: string }[];
    expect(toolMessages.some((m) => m.content.includes("outcome is unknown"))).toBe(true);
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
