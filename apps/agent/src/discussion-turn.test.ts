import { ToolRegistry } from "@everdict/agent-runtime";
import { InMemoryAgentSessionStore, InMemoryTenantKeyStore } from "@everdict/db";
import type { LlmTransport } from "@everdict/llm";
import { describe, expect, it, vi } from "vitest";
import type { CommentActivityReport } from "./comment-activity.js";
import { buildDiscussionPrompt } from "./discussion-turn.js";
import { type AgentServerDeps, buildServer } from "./server.js";

const THREAD = [
  { author: "u-a", authorName: "Alice", body: "the pass rate dipped", at: "2026-07-27T00:00:00.000Z" },
  { author: "u-b", authorName: "Bob", body: "@everdict why did it dip?", at: "2026-07-27T00:01:00.000Z" },
];

const TRIGGER = {
  workspace: "acme",
  askedBy: "u-b",
  resourceType: "harness",
  resourceId: "h-1",
  commentId: "cmt-1",
  sessionId: "disc-1",
  thread: THREAD,
};

// A transport that answers in one plain-text turn — the shape of a read-only discussion answer.
function answeringTransport(): LlmTransport {
  const usage = { inputTokens: 5, outputTokens: 1, totalTokens: 6 };
  return {
    provider: "fake",
    stream: async () => ({ content: "**The dip** came from case-7.", toolCalls: [], finishReason: "stop", usage }),
  };
}

// A transport whose first turn calls a WRITE tool (parking on HITL approval), then ends with text.
function actingTransport(): LlmTransport {
  let n = 0;
  const usage = { inputTokens: 5, outputTokens: 1, totalTokens: 6 };
  return {
    provider: "fake",
    stream: async () => {
      n += 1;
      if (n === 1) {
        return {
          content: null,
          toolCalls: [{ id: "t1", name: "retry_scorecard", arguments: JSON.stringify({ id: "sc-1" }) }],
          finishReason: "tool_calls",
          usage,
        };
      }
      return { content: "Retried the scorecard.", toolCalls: [], finishReason: "stop", usage };
    },
  };
}

function discussionDeps(transport: LlmTransport): {
  deps: AgentServerDeps;
  sessions: InMemoryAgentSessionStore;
  reports: CommentActivityReport[];
} {
  let n = 0;
  const sessions = new InMemoryAgentSessionStore();
  const reports: CommentActivityReport[] = [];
  const deps: AgentServerDeps = {
    // The minted agt_ token resolves to the ASKER the discussion turn acts as.
    authenticate: async () => ({ subject: "u-b", workspace: "acme", roles: ["member"] }),
    sessions,
    keyStore: new InMemoryTenantKeyStore(),
    internalToken: "shhh",
    commentActivity: async (report) => {
      reports.push(report);
    },
    resolveModel: async () => ({ transport, model: "test-model" }),
    toolProvider: async () => ({
      registry: new ToolRegistry([
        {
          name: "retry_scorecard",
          description: "Retry a scorecard's failed cases (mutating).",
          parametersJsonSchema: { type: "object" },
          isReadOnly: false,
          call: async () => ({ content: "retried", isError: false }),
        },
      ]),
      call: null,
      close: async () => {},
    }),
    systemPrompt: "test",
    now: () => "2026-07-27T00:00:00.000Z",
    newId: () => `id-${n++}`,
  };
  return { deps, sessions, reports };
}

describe("buildDiscussionPrompt", () => {
  it("names the resource, renders the thread oldest-first with display names, and asks for a self-contained markdown reply", () => {
    const prompt = buildDiscussionPrompt(TRIGGER);
    expect(prompt).toContain('harness "h-1"');
    expect(prompt.indexOf("Alice: the pass rate dipped")).toBeLessThan(
      prompt.indexOf("Bob: @everdict why did it dip?"),
    );
    expect(prompt).toContain("markdown answer");
  });
});

describe("POST /internal/discussion-turn — detached thread answer", () => {
  it("rejects a missing/wrong internal token", async () => {
    const { deps } = discussionDeps(answeringTransport());
    const app = buildServer(deps);
    expect((await app.inject({ method: "POST", url: "/internal/discussion-turn", payload: TRIGGER })).statusCode).toBe(
      401,
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/internal/discussion-turn",
          headers: { "x-internal-token": "wrong" },
          payload: TRIGGER,
        })
      ).statusCode,
    ).toBe(401);
    await app.close();
  });

  it("acks 202 and the detached turn creates the workspace-visible session, then lands the final markdown as complete", async () => {
    const { deps, sessions, reports } = discussionDeps(answeringTransport());
    const app = buildServer(deps);
    const res = await app.inject({
      method: "POST",
      url: "/internal/discussion-turn",
      headers: { "x-internal-token": "shhh" },
      payload: TRIGGER,
    });
    expect(res.statusCode).toBe(202); // detached — the answer lands via the activity bridge, not this response

    await vi.waitFor(() => {
      expect(reports.some((r) => r.status === "complete")).toBe(true);
    });
    const final = reports.find((r) => r.status === "complete");
    expect(final).toMatchObject({ workspace: "acme", commentId: "cmt-1", body: "**The dip** came from case-7." });

    // The thread's session is workspace-visible (any member can open/continue it) and owned by the asker.
    const session = await sessions.getVisibleSession("acme", "someone-else", "disc-1");
    expect(session).toMatchObject({ owner: "u-b", visibility: "workspace", title: "Discussion: harness h-1" });
    await app.close();
  });

  it("a write tool parks as awaiting_approval, is discoverable via GET /pending, and an allow resumes the turn to complete", async () => {
    const { deps, reports } = discussionDeps(actingTransport());
    const app = buildServer(deps);
    await app.inject({
      method: "POST",
      url: "/internal/discussion-turn",
      headers: { "x-internal-token": "shhh" },
      payload: TRIGGER,
    });
    // the park lands on the comment first (all viewers see 승인 대기)…
    await vi.waitFor(() => {
      expect(reports.some((r) => r.status === "awaiting_approval")).toBe(true);
    });
    expect(reports.find((r) => r.status === "awaiting_approval")?.activity).toBe("tool:retry_scorecard");
    // …then a panel opened mid-turn discovers the ask…
    const pendingRes = await app.inject({ method: "GET", url: "/agent/sessions/disc-1/pending", headers: {} });
    expect(pendingRes.statusCode).toBe(200);
    const pending = (pendingRes.json() as { pending: { requestId: string; name: string }[] }).pending;
    expect(pending).toHaveLength(1);
    expect(pending[0]?.name).toBe("retry_scorecard");
    // …and answers through the normal permission route, resuming the turn.
    const requestId = pending[0]?.requestId;
    const decide = await app.inject({
      method: "POST",
      url: "/agent/sessions/disc-1/permission",
      payload: { requestId, decision: "allow" },
    });
    expect(decide.statusCode).toBe(200);
    await vi.waitFor(() => {
      expect(reports.some((r) => r.status === "complete")).toBe(true);
    });
    expect(reports.find((r) => r.status === "complete")?.body).toBe("Retried the scorecard.");
    await app.close();
  });

  it("a turn that cannot produce an answer marks the comment failed", async () => {
    const { deps, reports } = discussionDeps(answeringTransport());
    // resolveModel blows up → the turn fails before any answer
    deps.resolveModel = async () => {
      throw new Error("no model configured");
    };
    const app = buildServer(deps);
    await app.inject({
      method: "POST",
      url: "/internal/discussion-turn",
      headers: { "x-internal-token": "shhh" },
      payload: TRIGGER,
    });
    await vi.waitFor(() => {
      expect(reports.some((r) => r.status === "failed")).toBe(true);
    });
    await app.close();
  });
});
