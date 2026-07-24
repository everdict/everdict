import { ToolRegistry } from "@everdict/agent-runtime";
import { UnauthenticatedError } from "@everdict/contracts";
import { InMemoryAgentSessionStore } from "@everdict/db";
import type { LlmTransport } from "@everdict/llm";
import { describe, expect, it, vi } from "vitest";
import type { ToolProvider } from "./mcp-tools.js";
import type { ModelResolver } from "./model.js";
import { type AgentServerDeps, buildServer } from "./server.js";

// A fake transport that always returns a fixed assistant reply and no tool calls (end_turn), so the server route can
// be exercised without a provider.
function fakeTransportAlways(text: string): LlmTransport {
  return {
    provider: "fake",
    stream: async (req) => {
      req.onContentDelta?.(text);
      return {
        content: text,
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
      };
    },
  };
}

function makeDeps(over: Partial<AgentServerDeps> = {}): AgentServerDeps {
  let n = 0;
  const resolveModel: ModelResolver = async () => ({ transport: fakeTransportAlways("Hi there"), model: "test-model" });
  const toolProvider: ToolProvider = async () => ({
    registry: new ToolRegistry([]),
    call: null,
    close: async () => {},
  });
  return {
    authenticate: async () => ({ subject: "alice", workspace: "acme", roles: ["member"] }),
    sessions: new InMemoryAgentSessionStore(),
    resolveModel,
    toolProvider,
    systemPrompt: "test",
    now: () => "2026-07-23T00:00:00.000Z",
    newId: () => `id-${n++}`,
    ...over,
  };
}

const auth = { authorization: "Bearer x", "x-everdict-workspace": "acme" };

describe("agent server", () => {
  it("creates a conversation and lists it for its owner", async () => {
    const app = buildServer(makeDeps());
    const created = await app.inject({ method: "POST", url: "/agent/sessions", headers: auth, payload: {} });
    expect(created.statusCode).toBe(201);
    expect(created.json().title).toBe("New conversation");

    const list = await app.inject({ method: "GET", url: "/agent/sessions", headers: auth });
    expect(list.json().sessions.map((s: { id: string }) => s.id)).toContain(created.json().id);
    await app.close();
  });

  it("runs a chat turn: persists the user message and the assistant reply", async () => {
    const app = buildServer(makeDeps());
    const session = (await app.inject({ method: "POST", url: "/agent/sessions", headers: auth, payload: {} })).json();

    const chat = await app.inject({
      method: "POST",
      url: `/agent/sessions/${session.id}/chat`,
      headers: auth,
      payload: { message: "hello" },
    });
    expect(chat.statusCode).toBe(200);
    const produced = chat.json().messages as { role: string; content: string }[];
    expect(produced[0]).toMatchObject({ role: "user", content: "hello" });
    expect(produced.at(-1)).toMatchObject({ role: "assistant", content: "Hi there" });

    const messages = (
      await app.inject({ method: "GET", url: `/agent/sessions/${session.id}/messages`, headers: auth })
    ).json().messages as { role: string }[];
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    await app.close();
  });

  it("absorbs a queued /input steering message into the running turn (mid-run steering)", async () => {
    const app = buildServer(makeDeps());
    const session = (await app.inject({ method: "POST", url: "/agent/sessions", headers: auth, payload: {} })).json();

    // Queue a steering message, then run a chat turn — the loop drains it at the turn boundary and persists it.
    const queued = await app.inject({
      method: "POST",
      url: `/agent/sessions/${session.id}/input`,
      headers: auth,
      payload: { message: "also check the regressions" },
    });
    expect(queued.statusCode).toBe(202);

    await app.inject({
      method: "POST",
      url: `/agent/sessions/${session.id}/chat`,
      headers: auth,
      payload: { message: "hello" },
    });

    const messages = (
      await app.inject({ method: "GET", url: `/agent/sessions/${session.id}/messages`, headers: auth })
    ).json().messages as { role: string; content: string }[];
    // The transcript keeps the injected user turn between the initial message and the assistant reply.
    expect(messages.map((m) => m.content)).toContain("also check the regressions");
    expect(messages.filter((m) => m.role === "user").map((m) => m.content)).toEqual([
      "hello",
      "also check the regressions",
    ]);
    await app.close();
  });

  it("rejects a /input steering message for a conversation the caller does not own", async () => {
    const app = buildServer(makeDeps());
    const res = await app.inject({
      method: "POST",
      url: "/agent/sessions/does-not-exist/input",
      headers: auth,
      payload: { message: "hi" },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("sets the conversation title from the first user message", async () => {
    const app = buildServer(makeDeps());
    const session = (await app.inject({ method: "POST", url: "/agent/sessions", headers: auth, payload: {} })).json();
    await app.inject({
      method: "POST",
      url: `/agent/sessions/${session.id}/chat`,
      headers: auth,
      payload: { message: "Summarize my last scorecard" },
    });
    const got = (await app.inject({ method: "GET", url: `/agent/sessions/${session.id}`, headers: auth })).json();
    expect(got.title).toBe("Summarize my last scorecard");
    await app.close();
  });

  describe("per-conversation model selection", () => {
    it("creates a conversation pinned to a chosen model and exposes it on read", async () => {
      const app = buildServer(makeDeps());
      const created = (
        await app.inject({ method: "POST", url: "/agent/sessions", headers: auth, payload: { model: "gpt-5-mini" } })
      ).json();
      expect(created.model).toBe("gpt-5-mini");
      const got = (await app.inject({ method: "GET", url: `/agent/sessions/${created.id}`, headers: auth })).json();
      expect(got.model).toBe("gpt-5-mini");
      await app.close();
    });

    it("changes the model via PATCH, and null clears it back to the default", async () => {
      const app = buildServer(makeDeps());
      const s = (await app.inject({ method: "POST", url: "/agent/sessions", headers: auth, payload: {} })).json();
      const patched = (
        await app.inject({
          method: "PATCH",
          url: `/agent/sessions/${s.id}`,
          headers: auth,
          payload: { model: "claude-sonnet" },
        })
      ).json();
      expect(patched.model).toBe("claude-sonnet");
      const cleared = (
        await app.inject({
          method: "PATCH",
          url: `/agent/sessions/${s.id}`,
          headers: auth,
          payload: { model: null },
        })
      ).json();
      expect(cleared.model).toBeUndefined();
      await app.close();
    });

    it("routes the turn through the conversation's chosen model (resolveModelById), not the default", async () => {
      const resolveModelById = vi.fn(async () => ({ transport: fakeTransportAlways("via picked"), model: "picked" }));
      const app = buildServer(makeDeps({ resolveModelById }));
      const s = (
        await app.inject({
          method: "POST",
          url: "/agent/sessions",
          headers: auth,
          payload: { model: "picked-model-id" },
        })
      ).json();
      await app.inject({
        method: "POST",
        url: `/agent/sessions/${s.id}/chat`,
        headers: auth,
        payload: { message: "hi" },
      });
      expect(resolveModelById).toHaveBeenCalledWith(expect.objectContaining({ subject: "alice" }), "picked-model-id");
      await app.close();
    });
  });

  it("returns 401 when the control plane rejects the identity", async () => {
    const app = buildServer(
      makeDeps({
        authenticate: async () => {
          throw new UnauthenticatedError("UNAUTHENTICATED");
        },
      }),
    );
    const res = await app.inject({ method: "GET", url: "/agent/sessions", headers: auth });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns 404 when chatting into a conversation that does not exist", async () => {
    const app = buildServer(makeDeps());
    const res = await app.inject({
      method: "POST",
      url: "/agent/sessions/missing/chat",
      headers: auth,
      payload: { message: "hi" },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("resolves @-references via the read tool and records them on the user message", async () => {
    const call = vi.fn(async () => ({ content: '{"id":"demo-qa","caseCount":2}', isError: false }));
    const toolProvider: ToolProvider = async () => ({ registry: new ToolRegistry([]), call, close: async () => {} });
    const app = buildServer(makeDeps({ toolProvider }));
    const session = (await app.inject({ method: "POST", url: "/agent/sessions", headers: auth, payload: {} })).json();
    await app.inject({
      method: "POST",
      url: `/agent/sessions/${session.id}/chat`,
      headers: auth,
      payload: {
        message: "describe it",
        references: [{ type: "dataset", id: "demo-qa", version: "1.0.0", label: "demo-qa" }],
      },
    });
    expect(call).toHaveBeenCalledWith("get_dataset", { id: "demo-qa", version: "1.0.0" });
    const messages = (
      await app.inject({ method: "GET", url: `/agent/sessions/${session.id}/messages`, headers: auth })
    ).json().messages as { role: string; references?: unknown }[];
    const user = messages.find((m) => m.role === "user");
    expect(user?.references).toEqual([{ type: "dataset", id: "demo-qa", version: "1.0.0", label: "demo-qa" }]);
    await app.close();
  });

  it("deletes a conversation", async () => {
    const app = buildServer(makeDeps());
    const session = (await app.inject({ method: "POST", url: "/agent/sessions", headers: auth, payload: {} })).json();
    expect(
      (await app.inject({ method: "DELETE", url: `/agent/sessions/${session.id}`, headers: auth })).statusCode,
    ).toBe(204);
    expect((await app.inject({ method: "GET", url: `/agent/sessions/${session.id}`, headers: auth })).statusCode).toBe(
      404,
    );
    await app.close();
  });

  // HITL approval route (the human's allow/deny for a parked write-tool call). The park/resolve mechanics are unit-
  // tested in permission-registry.test.ts; here we pin the HTTP contract: auth, session ownership, validation, and the
  // 404 for an id with no pending approval (a stale click, or a decision that raced the turn's end).
  describe("write-tool approval route", () => {
    it("rejects an invalid decision with 400", async () => {
      const app = buildServer(makeDeps());
      const session = (await app.inject({ method: "POST", url: "/agent/sessions", headers: auth, payload: {} })).json();
      const res = await app.inject({
        method: "POST",
        url: `/agent/sessions/${session.id}/permission`,
        headers: auth,
        payload: { requestId: "req-1", decision: "maybe" },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("returns 404 for a decision on a conversation the caller does not own", async () => {
      const app = buildServer(makeDeps());
      const res = await app.inject({
        method: "POST",
        url: "/agent/sessions/missing/permission",
        headers: auth,
        payload: { requestId: "req-1", decision: "allow" },
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("returns 404 when no approval is pending for the request id", async () => {
      const app = buildServer(makeDeps());
      const session = (await app.inject({ method: "POST", url: "/agent/sessions", headers: auth, payload: {} })).json();
      const res = await app.inject({
        method: "POST",
        url: `/agent/sessions/${session.id}/permission`,
        headers: auth,
        payload: { requestId: "nope", decision: "allow" },
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("returns 401 when the identity is unauthenticated", async () => {
      const app = buildServer(
        makeDeps({
          authenticate: async () => {
            throw new UnauthenticatedError("UNAUTHENTICATED");
          },
        }),
      );
      const res = await app.inject({
        method: "POST",
        url: "/agent/sessions/x/permission",
        headers: auth,
        payload: { requestId: "r", decision: "allow" },
      });
      expect(res.statusCode).toBe(401);
      await app.close();
    });
  });
});
