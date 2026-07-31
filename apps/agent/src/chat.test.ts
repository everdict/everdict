import { type ChatMessage, ToolRegistry } from "@everdict/agent-runtime";
import type { AgentMessageRecord } from "@everdict/contracts";
import { InMemoryAgentSessionStore } from "@everdict/db";
import type { LlmTransport, StreamRequest } from "@everdict/llm";
import { describe, expect, it } from "vitest";
import { type ChatDeps, maintainSessionMemory, runChat } from "./chat.js";

const PRINCIPAL = { subject: "u-1", workspace: "acme", roles: ["member"] };

async function seededDeps(transport: LlmTransport): Promise<{ deps: ChatDeps; sessions: InMemoryAgentSessionStore }> {
  let n = 0;
  const sessions = new InMemoryAgentSessionStore();
  await sessions.createSession({
    id: "s-1",
    tenant: "acme",
    owner: "u-1",
    title: "New conversation",
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z",
  });
  const deps: ChatDeps = {
    sessions,
    resolveModel: async () => ({ transport, model: "test-model" }),
    toolProvider: async () => ({ registry: new ToolRegistry([]), call: null, close: async () => {} }),
    systemPrompt: "test",
    now: () => "2026-07-31T00:00:00.000Z",
    newId: () => `id-${n++}`,
  };
  return { deps, sessions };
}

function record(seq: number, role: "user" | "assistant", content: string): AgentMessageRecord {
  return {
    id: `m-${seq}`,
    tenant: "acme",
    sessionId: "s-1",
    seq,
    role,
    content,
    createdAt: "2026-07-31T00:00:00.000Z",
  };
}

describe("session running memory", () => {
  it("folds the oldest records (to a clean user boundary) into a digest seeded with the previous memory", async () => {
    // Given a transcript past the trigger: 26 records alternating user/assistant (user on even seqs)
    const sessions = new InMemoryAgentSessionStore();
    await sessions.createSession({
      id: "s-1",
      tenant: "acme",
      owner: "u-1",
      title: "t",
      createdAt: "2026-07-31T00:00:00.000Z",
      updatedAt: "2026-07-31T00:00:00.000Z",
    });
    await sessions.appendMessages(
      Array.from({ length: 26 }, (_, i) => record(i, i % 2 === 0 ? "user" : "assistant", `message number ${i}`)),
    );
    const summarized: ChatMessage[][] = [];
    // When maintenance runs with a tiny trigger and a prior digest
    await maintainSessionMemory({
      sessions,
      workspace: "acme",
      sessionId: "s-1",
      previousMemory: "OLD DIGEST",
      coveredThroughSeq: undefined,
      summarize: async (span) => {
        summarized.push(span);
        return "NEW DIGEST";
      },
      now: "2026-07-31T01:00:00.000Z",
      triggerChars: 10,
    });
    // Then the fold cut at the first USER record inside the keep window (26-20=6 → seq 6), covering seq 0..5
    const s = await sessions.getSession("acme", "u-1", "s-1");
    expect(s?.memory).toBe("NEW DIGEST");
    expect(s?.memoryThroughSeq).toBe(5);
    // …and the summariser saw the PREVIOUS digest leading the folded span (nothing falls off the end)
    const seen = summarized[0] ?? [];
    expect(seen[0]?.content).toContain("OLD DIGEST");
    expect(seen.some((m) => typeof m.content === "string" && m.content.includes("message number 5"))).toBe(true);
    expect(seen.some((m) => typeof m.content === "string" && m.content.includes("message number 6"))).toBe(false);
  });

  it("does nothing below the trigger or when the summariser declines", async () => {
    const sessions = new InMemoryAgentSessionStore();
    await sessions.createSession({
      id: "s-1",
      tenant: "acme",
      owner: "u-1",
      title: "t",
      createdAt: "2026-07-31T00:00:00.000Z",
      updatedAt: "2026-07-31T00:00:00.000Z",
    });
    await sessions.appendMessages(Array.from({ length: 26 }, (_, i) => record(i, "user", `m${i}`)));
    // Below the trigger → untouched
    await maintainSessionMemory({
      sessions,
      workspace: "acme",
      sessionId: "s-1",
      previousMemory: undefined,
      coveredThroughSeq: undefined,
      summarize: async () => "SHOULD NOT RUN",
      now: "2026-07-31T01:00:00.000Z",
      triggerChars: 1_000_000,
    });
    expect((await sessions.getSession("acme", "u-1", "s-1"))?.memory).toBeUndefined();
    // Over the trigger but the summariser returns "" → keep replaying in full rather than dropping context
    await maintainSessionMemory({
      sessions,
      workspace: "acme",
      sessionId: "s-1",
      previousMemory: undefined,
      coveredThroughSeq: undefined,
      summarize: async () => "",
      now: "2026-07-31T01:00:00.000Z",
      triggerChars: 10,
    });
    expect((await sessions.getSession("acme", "u-1", "s-1"))?.memory).toBeUndefined();
  });

  it("replays the digest + only the uncovered tail on the next turn (bounded replay)", async () => {
    // Given a session whose memory covers seq ≤ 1
    const requests: StreamRequest[] = [];
    const transport: LlmTransport = {
      provider: "fake",
      stream: async (req) => {
        requests.push(req);
        return {
          content: "ok",
          toolCalls: [],
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      },
    };
    const { deps, sessions } = await seededDeps(transport);
    const s = await sessions.getSession("acme", "u-1", "s-1");
    if (!s) throw new Error("expected the seeded session");
    s.memory = "DIGEST OF THE EARLY SPAN";
    s.memoryThroughSeq = 1;
    await sessions.appendMessages([
      record(0, "user", "ancient question"),
      record(1, "assistant", "ancient answer"),
      record(2, "user", "recent question"),
      record(3, "assistant", "recent answer"),
    ]);
    // When the next turn runs
    await runChat(deps, PRINCIPAL, {}, "s-1", "continue");
    // Then the model saw the digest as the leading user turn, the uncovered tail, and NOT the covered records
    const sent = requests[0]?.messages ?? [];
    expect(sent[0]?.content).toContain("DIGEST OF THE EARLY SPAN");
    const texts = sent.map((m) => (typeof m.content === "string" ? m.content : ""));
    expect(texts.some((t) => t.includes("recent question"))).toBe(true);
    expect(texts.some((t) => t.includes("ancient question"))).toBe(false);
  });
});

describe("runChat knowledge auto-recall", () => {
  it("recalls workspace knowledge about @-referenced anchors via ONE get_task_context call (no reference → no recall)", async () => {
    // Given a tool session whose call channel records invocations and answers get_task_context with a claim
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const requests: StreamRequest[] = [];
    const transport: LlmTransport = {
      provider: "fake",
      stream: async (req) => {
        requests.push(req);
        return {
          content: "ok",
          toolCalls: [],
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      },
    };
    const { deps } = await seededDeps(transport);
    deps.toolProvider = async () => ({
      registry: new ToolRegistry([]),
      call: async (name, args) => {
        calls.push({ name, args });
        if (name === "get_task_context")
          return { content: "Known: web@2.1.0 fails case-7 under judge strictness", isError: false };
        return { content: `resolved:${name}`, isError: false };
      },
      close: async () => {},
    });
    // When the user sends a message carrying a harness reference (with its version coordinate)
    await runChat(deps, PRINCIPAL, {}, "s-1", "why did it dip?", [
      { type: "harness", id: "web", version: "2.1.0", label: "web" },
    ]);
    // Then get_task_context was asked once with the mapped node ref (the reference IS the anchor)
    const recall = calls.filter((c) => c.name === "get_task_context");
    expect(recall).toHaveLength(1);
    expect(recall[0]?.args).toEqual({ refs: [{ type: "harness", key: "web", version: "2.1.0" }] });
    // …and the model's user turn carries the recalled knowledge preamble before the user's words
    const sent = requests[0]?.messages ?? [];
    const userTurn = sent[sent.length - 1] as { content: string };
    expect(userTurn.content).toContain("web@2.1.0 fails case-7");
    expect(userTurn.content).toContain("why did it dip?");
  });
});

describe("runChat failure handling", () => {
  it("persists the turn's failure as an assistant record so the conversation survives (failure is a citizen)", async () => {
    // Given a model that fails permanently (a provider 400 — not retryable)
    const failing: LlmTransport = {
      provider: "fake",
      stream: async () => {
        throw Object.assign(new Error("model 400: invalid_request_error"), { status: 502, extra: { status: 400 } });
      },
    };
    const { deps, sessions } = await seededDeps(failing);
    // When the turn runs, Then it still throws (API semantics unchanged)…
    await expect(runChat(deps, PRINCIPAL, {}, "s-1", "hello")).rejects.toThrow();
    // …but the transcript records WHY, and the conversation is continuable rather than silently dead.
    const messages = await sessions.listMessages("acme", "s-1");
    const last = messages[messages.length - 1];
    expect(last?.role).toBe("assistant");
    expect(last?.content).toContain("The turn failed:");
    expect(last?.content).toContain("send a message to continue");
  });

  it("replays a crash-dangling transcript with synthetic tool results (the conversation is not bricked)", async () => {
    // Given a prior turn that persisted its tool_calls but died before any tool result (host crash mid-turn)
    const requests: StreamRequest[] = [];
    const transport: LlmTransport = {
      provider: "fake",
      stream: async (req) => {
        requests.push(req);
        return {
          content: "back on track",
          toolCalls: [],
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      },
    };
    const { deps, sessions } = await seededDeps(transport);
    await sessions.appendMessages([
      {
        id: "m-0",
        tenant: "acme",
        sessionId: "s-1",
        seq: 0,
        role: "user",
        content: "run the eval",
        createdAt: "2026-07-31T00:00:00.000Z",
      },
      {
        id: "m-1",
        tenant: "acme",
        sessionId: "s-1",
        seq: 1,
        role: "assistant",
        content: "",
        toolCalls: [{ id: "t-1", name: "run_scorecard", arguments: "{}" }],
        createdAt: "2026-07-31T00:00:01.000Z",
      },
      // …crash: no tool record for t-1 was ever persisted
    ]);
    // When the user continues the conversation
    const result = await runChat(deps, PRINCIPAL, {}, "s-1", "are you there?");
    // Then the model call succeeded (no provider rejection) over a REPAIRED history: the dangling call is answered
    expect(result.messages[result.messages.length - 1]?.content).toBe("back on track");
    const sent = requests[0]?.messages ?? [];
    const toolMessages = sent.filter((m) => m.role === "tool") as { tool_call_id: string; content: string }[];
    expect(toolMessages.some((m) => m.tool_call_id === "t-1" && m.content.includes("Tool result missing"))).toBe(true);
  });
});
