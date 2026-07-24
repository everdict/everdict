import { ToolRegistry } from "@everdict/agent-runtime";
import { InMemoryAgentSessionStore } from "@everdict/db";
import type { LlmTransport } from "@everdict/llm";
import { describe, expect, it } from "vitest";
import { AgentMailbox } from "./agent-mailbox.js";
import type { ChatDeps } from "./chat.js";
import type { Authenticate } from "./principal.js";
import { runTeammateTurn } from "./teammate-turn.js";

function fakeModel(text: string): LlmTransport {
  return {
    provider: "fake",
    stream: async () => ({
      content: text,
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
    }),
  };
}

function makeDeps(sessions: InMemoryAgentSessionStore): ChatDeps {
  let n = 0;
  return {
    sessions,
    resolveModel: async () => ({ transport: fakeModel("on it"), model: "m" }),
    toolProvider: async () => ({ registry: new ToolRegistry([]), call: null, close: async () => {} }),
    systemPrompt: "teammate",
    now: () => "2026-07-24T00:00:00.000Z",
    newId: () => `id-${n++}`,
  };
}

// The agt_ token resolves to the agent principal that acts AS the teammate's creator (owns the session).
const authenticate: Authenticate = async () => ({
  subject: "agent-owner",
  workspace: "acme",
  roles: ["member"],
  via: "agent",
});

const now = "2026-07-24T00:00:00.000Z";

describe("runTeammateTurn", () => {
  it("authenticates via the agt_ token, drains the mailbox, and runs a request-less turn over the incoming message", async () => {
    const sessions = new InMemoryAgentSessionStore();
    await sessions.createSession({
      id: "tm1",
      tenant: "acme",
      owner: "agent-owner",
      title: "researcher",
      createdAt: now,
      updatedAt: now,
    });
    const mailbox = new AgentMailbox();
    mailbox.enqueue("acme", "tm1", { from: "agent", sender: "lead", content: "dig into sc_123" });

    await runTeammateTurn(makeDeps(sessions), authenticate, mailbox, "tm1", "agt_test");

    const msgs = await sessions.listMessages("acme", "tm1");
    // The incoming (attributed) message became the turn's prompt; the loop produced an assistant reply.
    expect(msgs.some((m) => m.role === "user" && m.content.includes("dig into sc_123"))).toBe(true);
    expect(msgs.some((m) => m.role === "assistant" && m.content === "on it")).toBe(true);
    // The mailbox was consumed.
    expect(mailbox.drain("acme", "tm1")).toEqual([]);
  });

  it("is a no-op when the teammate is woken with an empty mailbox", async () => {
    const sessions = new InMemoryAgentSessionStore();
    await sessions.createSession({
      id: "tm2",
      tenant: "acme",
      owner: "agent-owner",
      title: "idle",
      createdAt: now,
      updatedAt: now,
    });
    await runTeammateTurn(makeDeps(sessions), authenticate, new AgentMailbox(), "tm2", "agt_test");
    expect(await sessions.listMessages("acme", "tm2")).toEqual([]);
  });
});
