import { CommentService, type DiscussionTurnRunner, RunService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import { InMemoryCommentStore, InMemoryRunStore } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../server.js";

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused in comment tests");
  },
};
const svc = () => new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() });
const acme = { "x-everdict-tenant": "acme" };

type RunnerInput = Parameters<DiscussionTurnRunner["run"]>[0];

function harness(opts: { failRunner?: boolean } = {}) {
  const store = new InMemoryCommentStore();
  const calls: RunnerInput[] = [];
  const commentService = new CommentService({
    store,
    discussionRunner: {
      run: async (input) => {
        calls.push(input);
        if (opts.failRunner) throw new Error("agent unreachable");
      },
    },
  });
  const app = buildServer({ service: svc(), commentService, internalToken: "itok" });
  return { app, store, calls };
}

// A headless agent posts over HTTP with the member's own bearer, so the declaration headers are the only thing
// separating "Everdict answered" from "the operator commented".
describe("comments — agent authorship over HTTP", () => {
  it("POST /comments with the agent declaration headers is authored by Everdict, not the member", async () => {
    const { app } = harness();
    const res = await app.inject({
      method: "POST",
      url: "/comments",
      headers: {
        ...acme,
        "x-everdict-agent-id": "triage",
        "x-everdict-agent-name": "Triage",
        "x-everdict-conversation-id": "conv-9",
      },
      payload: { resourceType: "issue", resourceId: "ENG-12", body: "The regression traces to judge-v3." },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      author: "everdict:agent",
      authorKind: "agent",
      agentStatus: "complete",
      agentSessionId: "conv-9",
    });
    await app.close();
  });

  it("POST /comments without those headers stays the member's own comment", async () => {
    const { app } = harness();
    const res = await app.inject({
      method: "POST",
      url: "/comments",
      headers: acme,
      payload: { resourceType: "issue", resourceId: "ENG-12", body: "my own note" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().authorKind).toBeUndefined();
    expect(res.json().author).not.toBe("everdict:agent");
    await app.close();
  });
});

// The discussion-agent transport surface: askAgent on POST /comments + the internal lifecycle callback.
describe("comments — @everdict discussion agent", () => {
  it("POST /comments with askAgent creates the member comment AND a running agent placeholder, firing the trigger", async () => {
    const { app, calls } = harness();
    const res = await app.inject({
      method: "POST",
      url: "/comments",
      headers: acme,
      payload: { resourceType: "harness", resourceId: "h-1", body: "@everdict summarize", askAgent: true },
    });
    expect(res.statusCode).toBe(201);
    expect(calls).toHaveLength(1);
    const list = await app.inject({
      method: "GET",
      url: "/comments?resourceType=harness&resourceId=h-1",
      headers: acme,
    });
    const comments = (list.json() as { comments: Array<Record<string, unknown>> }).comments;
    const placeholder = comments.find((c) => c.authorKind === "agent");
    expect(placeholder).toMatchObject({ agentStatus: "running", agentActivity: "thinking" });
    expect(placeholder?.agentSessionId).toBe(calls[0]?.sessionId);
    await app.close();
  });

  it("a second askAgent while the first is still running → 409", async () => {
    const { app } = harness();
    const first = await app.inject({
      method: "POST",
      url: "/comments",
      headers: acme,
      payload: { resourceType: "harness", resourceId: "h-1", body: "@everdict q1", askAgent: true },
    });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: "POST",
      url: "/comments",
      headers: acme,
      payload: { resourceType: "harness", resourceId: "h-1", body: "@everdict q2", askAgent: true },
    });
    expect(second.statusCode).toBe(409);
    await app.close();
  });

  it("POST /internal/comment-activity is x-internal-token gated and drives the placeholder to its final answer", async () => {
    const { app, calls } = harness();
    await app.inject({
      method: "POST",
      url: "/comments",
      headers: acme,
      payload: { resourceType: "harness", resourceId: "h-1", body: "@everdict q", askAgent: true },
    });
    const commentId = calls[0]?.commentId;
    // wrong/absent token → 403
    const bad = await app.inject({
      method: "POST",
      url: "/internal/comment-activity",
      headers: { "x-internal-token": "nope" },
      payload: { tenant: "acme", commentId, activity: "tool:get_harness_instance" },
    });
    expect(bad.statusCode).toBe(403);
    // activity patch, then the terminal patch
    const act = await app.inject({
      method: "POST",
      url: "/internal/comment-activity",
      headers: { "x-internal-token": "itok" },
      payload: { tenant: "acme", commentId, activity: "tool:get_harness_instance" },
    });
    expect(act.statusCode).toBe(200);
    const done = await app.inject({
      method: "POST",
      url: "/internal/comment-activity",
      headers: { "x-internal-token": "itok" },
      payload: { tenant: "acme", commentId, status: "complete", body: "**answer**" },
    });
    expect(done.statusCode).toBe(200);
    const list = await app.inject({
      method: "GET",
      url: "/comments?resourceType=harness&resourceId=h-1",
      headers: acme,
    });
    const placeholder = (list.json() as { comments: Array<Record<string, unknown>> }).comments.find(
      (c) => c.authorKind === "agent",
    );
    expect(placeholder).toMatchObject({ agentStatus: "complete", body: "**answer**" });
    expect(placeholder?.agentActivity).toBeUndefined();
    await app.close();
  });

  it("POST /internal/comment-activity on a member comment → 404 (only agent comments are mutable)", async () => {
    const { app } = harness();
    const created = await app.inject({
      method: "POST",
      url: "/comments",
      headers: acme,
      payload: { resourceType: "harness", resourceId: "h-1", body: "a note" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/internal/comment-activity",
      headers: { "x-internal-token": "itok" },
      payload: { tenant: "acme", commentId: (created.json() as { id: string }).id, status: "complete" },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
