import { type ToolDefinition, ToolRegistry } from "@everdict/agent-runtime";
import { UnauthenticatedError } from "@everdict/contracts";
import { InMemoryAgentSessionStore, InMemoryAnalysisArtifactStore, InMemoryTenantKeyStore } from "@everdict/db";
import type { LlmTransport } from "@everdict/llm";
import { describe, expect, it, vi } from "vitest";
import { INTERRUPTED_BY_USER } from "./chat.js";
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

// A transport that calls a named tool on turn 1, then replies with text on turn 2 — for exercising the write-tool
// permission path (the always-text fake never asks for a tool).
function callThenText(toolName: string): LlmTransport {
  let n = 0;
  const usage = { inputTokens: 5, outputTokens: 1, totalTokens: 6 };
  return {
    provider: "fake",
    stream: async () => {
      n += 1;
      if (n === 1) {
        return {
          content: null,
          toolCalls: [{ id: "w1", name: toolName, arguments: "{}" }],
          finishReason: "tool_calls",
          usage,
        };
      }
      return { content: "done", toolCalls: [], finishReason: "stop", usage };
    },
  };
}

function writeToolDeps(writeCall: () => Promise<{ content: string; isError: boolean }>): Partial<AgentServerDeps> {
  const writeTool: ToolDefinition = {
    name: "do_write",
    description: "write",
    parametersJsonSchema: { type: "object", properties: {} },
    isReadOnly: false,
    call: writeCall,
  };
  return {
    resolveModel: async () => ({ transport: callThenText("do_write"), model: "test-model" }),
    toolProvider: async () => ({ registry: new ToolRegistry([writeTool]), call: null, close: async () => {} }),
  };
}

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

  it("a turn can emit an analysis artifact (render_chart) — persisted and listed on the conversation", async () => {
    // Turn 1 calls render_chart with a valid spec; turn 2 ends with text.
    let n = 0;
    const usage = { inputTokens: 5, outputTokens: 1, totalTokens: 6 };
    const chartCall: LlmTransport = {
      provider: "fake",
      stream: async () => {
        n += 1;
        if (n === 1) {
          return {
            content: null,
            toolCalls: [
              {
                id: "a1",
                name: "render_chart",
                arguments: JSON.stringify({
                  title: "Pass rate by harness",
                  spec: { type: "bar", x: ["h1"], series: [{ label: "passRate", points: [0.9] }] },
                }),
              },
            ],
            finishReason: "tool_calls",
            usage,
          };
        }
        return { content: "charted", toolCalls: [], finishReason: "stop", usage };
      },
    };
    const artifacts = new InMemoryAnalysisArtifactStore();
    const app = buildServer(
      makeDeps({ artifacts, resolveModel: async () => ({ transport: chartCall, model: "test-model" }) }),
    );
    const session = (await app.inject({ method: "POST", url: "/agent/sessions", headers: auth, payload: {} })).json();
    const chat = await app.inject({
      method: "POST",
      url: `/agent/sessions/${session.id}/chat`,
      headers: auth,
      payload: { message: "chart the pass rate" },
    });
    expect(chat.statusCode).toBe(200);

    const listed = await app.inject({ method: "GET", url: `/agent/sessions/${session.id}/artifacts`, headers: auth });
    expect(listed.statusCode).toBe(200);
    const arts = listed.json().artifacts as { kind: string; title: string }[];
    expect(arts).toHaveLength(1);
    expect(arts[0]).toMatchObject({ kind: "chart", title: "Pass rate by harness" });

    // Unknown/foreign session → 404 (no existence leak).
    expect((await app.inject({ method: "GET", url: "/agent/sessions/nope/artifacts", headers: auth })).statusCode).toBe(
      404,
    );
    await app.close();
  });

  it("GET /agent/views/:id/artifacts lists the view's pinned artifacts, gated by control-plane view visibility", async () => {
    const artifacts = new InMemoryAnalysisArtifactStore();
    await artifacts.create({
      id: "art-1",
      tenant: "acme",
      kind: "report",
      title: "Weekly",
      sessionId: "s1",
      pinned: false,
      spec: { markdown: "# hi" },
      createdBy: "alice",
      createdAt: "2026-07-01T00:00:00.000Z",
    });
    await artifacts.attachToView("acme", "art-1", "v-1");
    // The control plane says: v-1 visible, v-private not (its ViewService already 404s foreign/private views).
    const app = buildServer(makeDeps({ artifacts, checkViewAccess: async (_h, viewId) => viewId === "v-1" }));

    const ok = await app.inject({ method: "GET", url: "/agent/views/v-1/artifacts", headers: auth });
    expect(ok.statusCode).toBe(200);
    expect((ok.json().artifacts as { id: string }[]).map((a) => a.id)).toEqual(["art-1"]);

    expect(
      (await app.inject({ method: "GET", url: "/agent/views/v-private/artifacts", headers: auth })).statusCode,
    ).toBe(404); // not visible → 404, no existence leak
    await app.close();
  });

  it("pin/unpin: the creator curates their artifact onto a visible view; foreign artifacts and views 404", async () => {
    const artifacts = new InMemoryAnalysisArtifactStore();
    const mine = {
      id: "art-1",
      tenant: "acme",
      kind: "chart" as const,
      title: "Mine",
      sessionId: "s1",
      pinned: false,
      spec: { type: "line", x: ["a"], series: [{ label: "s", points: [1] }] },
      createdBy: "alice",
      createdAt: "2026-07-01T00:00:00.000Z",
    };
    await artifacts.create(mine);
    await artifacts.create({ ...mine, id: "art-bob", createdBy: "bob" });
    const app = buildServer(makeDeps({ artifacts, checkViewAccess: async (_h, viewId) => viewId === "v-1" }));

    // Pin my artifact to a visible view.
    const pinned = await app.inject({
      method: "POST",
      url: "/agent/artifacts/art-1/pin",
      headers: auth,
      payload: { viewId: "v-1" },
    });
    expect(pinned.statusCode).toBe(200);
    expect(pinned.json()).toMatchObject({ viewId: "v-1", pinned: true });

    // Not my artifact / invisible view → 404 (no existence leak).
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/agent/artifacts/art-bob/pin",
          headers: auth,
          payload: { viewId: "v-1" },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/agent/artifacts/art-1/pin",
          headers: auth,
          payload: { viewId: "v-private" },
        })
      ).statusCode,
    ).toBe(404);

    // Unpin.
    expect((await app.inject({ method: "DELETE", url: "/agent/artifacts/art-1/pin", headers: auth })).statusCode).toBe(
      204,
    );
    expect((await artifacts.get("acme", "art-1"))?.pinned).toBe(false);
    await app.close();
  });

  it("artifacts-summary answers only for the requested ids (no view-id disclosure)", async () => {
    const artifacts = new InMemoryAnalysisArtifactStore();
    const base = {
      tenant: "acme",
      kind: "report" as const,
      title: "r",
      sessionId: "s1",
      pinned: false,
      spec: { markdown: "# r" },
      createdBy: "alice",
      createdAt: "2026-07-01T00:00:00.000Z",
    };
    await artifacts.create({ ...base, id: "a1" });
    await artifacts.create({ ...base, id: "a2" });
    await artifacts.attachToView("acme", "a1", "v-known");
    await artifacts.attachToView("acme", "a2", "v-secret");
    const app = buildServer(makeDeps({ artifacts }));

    const res = await app.inject({ method: "GET", url: "/agent/views/artifacts-summary?ids=v-known", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json().summary)).toEqual(["v-known"]); // v-secret never leaves the server
    expect((await app.inject({ method: "GET", url: "/agent/views/artifacts-summary", headers: auth })).statusCode).toBe(
      400,
    );
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

  it("routes an agent's send_message to another of the caller's conversations (S2 generalization)", async () => {
    const usage = { inputTokens: 5, outputTokens: 1, totalTokens: 6 };
    let targetId = "";
    let n = 0;
    // Session A's agent calls send_message(to: B) on its first turn, then replies; later turns (session B) just reply.
    const scripted: LlmTransport = {
      provider: "fake",
      stream: async () => {
        n += 1;
        if (n === 1) {
          return {
            content: null,
            toolCalls: [
              { id: "m1", name: "send_message", arguments: JSON.stringify({ to: targetId, message: "hello B" }) },
            ],
            finishReason: "tool_calls",
            usage,
          };
        }
        return { content: "reply", toolCalls: [], finishReason: "stop", usage };
      },
    };
    const app = buildServer(makeDeps({ resolveModel: async () => ({ transport: scripted, model: "m" }) }));
    const a = (await app.inject({ method: "POST", url: "/agent/sessions", headers: auth, payload: {} })).json();
    const b = (await app.inject({ method: "POST", url: "/agent/sessions", headers: auth, payload: {} })).json();
    targetId = b.id;

    await app.inject({
      method: "POST",
      url: `/agent/sessions/${a.id}/chat`,
      headers: auth,
      payload: { message: "go" },
    });
    // B has not run yet — the message waits in B's mailbox; B's next turn drains it.
    await app.inject({ method: "POST", url: `/agent/sessions/${b.id}/chat`, headers: auth, payload: { message: "?" } });

    const bMsgs = (await app.inject({ method: "GET", url: `/agent/sessions/${b.id}/messages`, headers: auth })).json()
      .messages as { content: string }[];
    const delivered = bMsgs.find((m) => m.content.includes("hello B"));
    expect(delivered?.content).toContain("[Message from teammate");
    expect(delivered?.content).toContain("hello B");
    await app.close();
  });

  it("spawns a teammate that autonomously processes its standing task (S3 end-to-end)", async () => {
    const app = buildServer(makeDeps({ keyStore: new InMemoryTenantKeyStore() }));
    const spawned = await app.inject({
      method: "POST",
      url: "/agent/teammates",
      headers: auth,
      payload: { name: "researcher", task: "analyze sc_123" },
    });
    expect(spawned.statusCode).toBe(201);
    const { id, name } = spawned.json();
    expect(name).toBe("researcher");
    // The supervisor woke the teammate; let its request-less turn run.
    await new Promise((r) => setTimeout(r, 30));
    const msgs = (await app.inject({ method: "GET", url: `/agent/sessions/${id}/messages`, headers: auth })).json()
      .messages as { role: string; content: string }[];
    expect(msgs.some((m) => m.role === "user" && m.content.includes("analyze sc_123"))).toBe(true);
    expect(msgs.some((m) => m.role === "assistant" && m.content === "Hi there")).toBe(true);
    await app.close();
  });

  it("lets an agent spawn a teammate via the spawn_teammate tool, which then processes its task (autonomous collaboration)", async () => {
    const usage = { inputTokens: 5, outputTokens: 1, totalTokens: 6 };
    let n = 0;
    // The chat agent calls spawn_teammate on its first turn, then replies; every later turn (incl. the teammate's) is text.
    const scripted: LlmTransport = {
      provider: "fake",
      stream: async () => {
        n += 1;
        if (n === 1) {
          return {
            content: null,
            toolCalls: [
              {
                id: "t1",
                name: "spawn_teammate",
                arguments: JSON.stringify({ name: "researcher", task: "watch regressions" }),
              },
            ],
            finishReason: "tool_calls",
            usage,
          };
        }
        return { content: "delegated", toolCalls: [], finishReason: "stop", usage };
      },
    };
    const app = buildServer(
      makeDeps({
        resolveModel: async () => ({ transport: scripted, model: "m" }),
        keyStore: new InMemoryTenantKeyStore(),
      }),
    );
    const chat = (await app.inject({ method: "POST", url: "/agent/sessions", headers: auth, payload: {} })).json();
    await app.inject({
      method: "POST",
      url: `/agent/sessions/${chat.id}/chat`,
      headers: auth,
      payload: { message: "spin up a researcher teammate" },
    });
    // The spawn is synchronous within the tool call → the teammate session exists by now.
    const sessions = (await app.inject({ method: "GET", url: "/agent/sessions", headers: auth })).json().sessions as {
      id: string;
      title: string;
    }[];
    const teammate = sessions.find((s) => s.title === "researcher");
    expect(teammate).toBeDefined();
    // The teammate was woken; let its autonomous turn run and process the standing task.
    await new Promise((r) => setTimeout(r, 30));
    const msgs = (
      await app.inject({ method: "GET", url: `/agent/sessions/${teammate?.id}/messages`, headers: auth })
    ).json().messages as { content: string }[];
    expect(msgs.some((m) => m.content.includes("watch regressions"))).toBe(true);
    await app.close();
  });

  it("lists the caller's teammates and stops one (roster)", async () => {
    const app = buildServer(makeDeps({ keyStore: new InMemoryTenantKeyStore() }));
    const r1 = (
      await app.inject({
        method: "POST",
        url: "/agent/teammates",
        headers: auth,
        payload: { name: "researcher", task: "t1" },
      })
    ).json();
    await app.inject({
      method: "POST",
      url: "/agent/teammates",
      headers: auth,
      payload: { name: "analyst", task: "t2" },
    });

    const list = (await app.inject({ method: "GET", url: "/agent/teammates", headers: auth })).json().teammates as {
      id: string;
      name: string;
    }[];
    expect(list.map((t) => t.name).sort()).toEqual(["analyst", "researcher"]);

    const del = await app.inject({ method: "DELETE", url: `/agent/teammates/${r1.id}`, headers: auth });
    expect(del.statusCode).toBe(204);

    const list2 = (await app.inject({ method: "GET", url: "/agent/teammates", headers: auth })).json().teammates as {
      name: string;
    }[];
    expect(list2.map((t) => t.name)).toEqual(["analyst"]);
    await app.close();
  });

  it("fans a platform event out to the teammates that watch its kind, waking them (S4 proactive)", async () => {
    const app = buildServer(makeDeps({ keyStore: new InMemoryTenantKeyStore() }));
    const watcher = (
      await app.inject({
        method: "POST",
        url: "/agent/teammates",
        headers: auth,
        payload: { name: "watcher", task: "watch regressions", watch: ["scorecard.regressed"] },
      })
    ).json();
    // A teammate watching a different kind must NOT be woken.
    await app.inject({
      method: "POST",
      url: "/agent/teammates",
      headers: auth,
      payload: { name: "other", task: "watch capacity", watch: ["runtime.backpressure"] },
    });

    const fanned = (
      await app.inject({
        method: "POST",
        url: "/agent/events",
        headers: auth,
        payload: { kind: "scorecard.regressed", source: "scorecard sc_9", message: "sc_9 regressed on 3 cases" },
      })
    ).json();
    expect(fanned.notified).toBe(1); // only the watcher

    await new Promise((r) => setTimeout(r, 30)); // let the woken teammate react
    const msgs = (
      await app.inject({ method: "GET", url: `/agent/sessions/${watcher.id}/messages`, headers: auth })
    ).json().messages as { content: string }[];
    expect(msgs.some((m) => m.content.includes("sc_9 regressed on 3 cases"))).toBe(true);
    await app.close();
  });

  it("fans an event via the internal control-plane path (x-internal-token) to a recipient's teammates (S4)", async () => {
    const app = buildServer(makeDeps({ keyStore: new InMemoryTenantKeyStore(), internalToken: "sekret" }));
    const watcher = (
      await app.inject({
        method: "POST",
        url: "/agent/teammates",
        headers: auth,
        payload: { name: "watcher", task: "watch", watch: ["scorecard.regressed"] },
      })
    ).json();
    // The control plane (not a user) drives the event for recipient=alice in workspace=acme.
    const fanned = (
      await app.inject({
        method: "POST",
        url: "/agent/events",
        headers: { "x-internal-token": "sekret" },
        payload: { workspace: "acme", recipient: "alice", kind: "scorecard.regressed", message: "sc_9 regressed" },
      })
    ).json();
    expect(fanned.notified).toBe(1);
    await new Promise((r) => setTimeout(r, 30));
    const msgs = (
      await app.inject({ method: "GET", url: `/agent/sessions/${watcher.id}/messages`, headers: auth })
    ).json().messages as { content: string }[];
    expect(msgs.some((m) => m.content.includes("sc_9 regressed"))).toBe(true);
    await app.close();
  });

  it("rejects the internal event path with a bad token (401)", async () => {
    const app = buildServer(makeDeps({ keyStore: new InMemoryTenantKeyStore(), internalToken: "sekret" }));
    const res = await app.inject({
      method: "POST",
      url: "/agent/events",
      headers: { "x-internal-token": "wrong" },
      payload: { workspace: "acme", recipient: "alice", kind: "x", message: "y" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("fanning an event with a kind nothing watches notifies no one", async () => {
    const app = buildServer(makeDeps({ keyStore: new InMemoryTenantKeyStore() }));
    await app.inject({
      method: "POST",
      url: "/agent/teammates",
      headers: auth,
      payload: { name: "watcher", task: "watch", watch: ["scorecard.regressed"] },
    });
    const fanned = (
      await app.inject({
        method: "POST",
        url: "/agent/events",
        headers: auth,
        payload: { kind: "nobody.watches.this", message: "ignored" },
      })
    ).json();
    expect(fanned.notified).toBe(0);
    await app.close();
  });

  it("stopping an unknown teammate is 404", async () => {
    const app = buildServer(makeDeps({ keyStore: new InMemoryTenantKeyStore() }));
    const res = await app.inject({ method: "DELETE", url: "/agent/teammates/nope", headers: auth });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("teammate spawn is 404 when no key store (agent token issuance) is configured", async () => {
    const app = buildServer(makeDeps()); // no keyStore
    const res = await app.inject({
      method: "POST",
      url: "/agent/teammates",
      headers: auth,
      payload: { name: "x", task: "y" },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("absorbs a platform /event into the running turn, attributed as an Everdict event", async () => {
    const app = buildServer(makeDeps());
    const session = (await app.inject({ method: "POST", url: "/agent/sessions", headers: auth, payload: {} })).json();
    const queued = await app.inject({
      method: "POST",
      url: `/agent/sessions/${session.id}/event`,
      headers: auth,
      payload: { message: "completed with 2 failures", source: "scorecard sc_123" },
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
    // The event is folded into the transcript, attributed so the agent knows it is a platform event.
    const eventMsg = messages.find((m) => m.content.includes("scorecard sc_123"));
    expect(eventMsg?.content).toContain("[Everdict event — scorecard sc_123]");
    expect(eventMsg?.content).toContain("completed with 2 failures");
    await app.close();
  });

  it("resolves the fallback model up front and the small model lazily (only when compaction fires)", async () => {
    const resolveModelById = vi.fn(async (_principal: unknown, _ref: string) => ({
      transport: fakeTransportAlways("Hi there"),
      model: "tier-model",
    }));
    const app = buildServer(makeDeps({ resolveModelById, smallModelRef: "small-id", fallbackModelRef: "fb-id" }));
    const session = (await app.inject({ method: "POST", url: "/agent/sessions", headers: auth, payload: {} })).json();
    await app.inject({
      method: "POST",
      url: `/agent/sessions/${session.id}/chat`,
      headers: auth,
      payload: { message: "hello" },
    });
    const refs = resolveModelById.mock.calls.map((c) => c[1]);
    // The fallback is resolved eagerly (ready before the main model can fail); a normal turn triggers no compaction,
    // so the small summariser model is never resolved (lazy — no cost when unused).
    expect(refs).toContain("fb-id");
    expect(refs).not.toContain("small-id");
    await app.close();
  });

  describe("permission modes and fine-grained rules", () => {
    it("a session deny-rule blocks a write tool without prompting", async () => {
      const writeCall = vi.fn(async () => ({ content: "wrote", isError: false }));
      const app = buildServer(makeDeps(writeToolDeps(writeCall)));
      const s = (await app.inject({ method: "POST", url: "/agent/sessions", headers: auth, payload: {} })).json();
      await app.inject({
        method: "POST",
        url: `/agent/sessions/${s.id}/rules`,
        headers: auth,
        payload: { tool: "do_write", decision: "deny" },
      });
      await app.inject({
        method: "POST",
        url: `/agent/sessions/${s.id}/chat`,
        headers: auth,
        payload: { message: "write it" },
      });
      expect(writeCall).not.toHaveBeenCalled();
      await app.close();
    });

    it("plan mode blocks a write tool until a plan is presented", async () => {
      const writeCall = vi.fn(async () => ({ content: "wrote", isError: false }));
      const app = buildServer(makeDeps(writeToolDeps(writeCall)));
      const s = (await app.inject({ method: "POST", url: "/agent/sessions", headers: auth, payload: {} })).json();
      await app.inject({
        method: "POST",
        url: `/agent/sessions/${s.id}/chat`,
        headers: auth,
        payload: { message: "write it", mode: "plan" },
      });
      // The model called do_write without presenting a plan first → blocked.
      expect(writeCall).not.toHaveBeenCalled();
      await app.close();
    });

    it("manages rules over their CRUD endpoints", async () => {
      const app = buildServer(makeDeps());
      const s = (await app.inject({ method: "POST", url: "/agent/sessions", headers: auth, payload: {} })).json();
      const added = await app.inject({
        method: "POST",
        url: `/agent/sessions/${s.id}/rules`,
        headers: auth,
        payload: { tool: "do_write", decision: "allow" },
      });
      expect(added.json().rules).toEqual({ do_write: "allow" });
      const listed = await app.inject({ method: "GET", url: `/agent/sessions/${s.id}/rules`, headers: auth });
      expect(listed.json().rules).toEqual({ do_write: "allow" });
      const removed = await app.inject({
        method: "DELETE",
        url: `/agent/sessions/${s.id}/rules/do_write`,
        headers: auth,
      });
      expect(removed.statusCode).toBe(204);
      const empty = await app.inject({ method: "GET", url: `/agent/sessions/${s.id}/rules`, headers: auth });
      expect(empty.json().rules).toEqual({});
      await app.close();
    });

    it("rejects rules for a conversation the caller does not own", async () => {
      const app = buildServer(makeDeps());
      const res = await app.inject({
        method: "POST",
        url: "/agent/sessions/nope/rules",
        headers: auth,
        payload: { tool: "do_write", decision: "allow" },
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("persists the session's standing permission mode via PATCH, and null clears it back to default", async () => {
      const app = buildServer(makeDeps());
      const s = (await app.inject({ method: "POST", url: "/agent/sessions", headers: auth, payload: {} })).json();
      const patched = (
        await app.inject({
          method: "PATCH",
          url: `/agent/sessions/${s.id}`,
          headers: auth,
          payload: { permissionMode: "auto" },
        })
      ).json();
      expect(patched.permissionMode).toBe("auto");
      const cleared = (
        await app.inject({
          method: "PATCH",
          url: `/agent/sessions/${s.id}`,
          headers: auth,
          payload: { permissionMode: null },
        })
      ).json();
      expect(cleared.permissionMode).toBeUndefined();
      await app.close();
    });

    it("a turn without an explicit mode runs under the session's standing mode (plan blocks the write)", async () => {
      const writeCall = vi.fn(async () => ({ content: "wrote", isError: false }));
      const app = buildServer(makeDeps(writeToolDeps(writeCall)));
      const s = (await app.inject({ method: "POST", url: "/agent/sessions", headers: auth, payload: {} })).json();
      await app.inject({
        method: "PATCH",
        url: `/agent/sessions/${s.id}`,
        headers: auth,
        payload: { permissionMode: "plan" },
      });
      await app.inject({
        method: "POST",
        url: `/agent/sessions/${s.id}/chat`,
        headers: auth,
        payload: { message: "write it" }, // no body.mode → the session's standing "plan" applies
      });
      expect(writeCall).not.toHaveBeenCalled();
      await app.close();
    });

    it("a standing bypass mode skips even a session deny-rule (no permission gate at all)", async () => {
      const writeCall = vi.fn(async () => ({ content: "wrote", isError: false }));
      const app = buildServer(makeDeps(writeToolDeps(writeCall)));
      const s = (await app.inject({ method: "POST", url: "/agent/sessions", headers: auth, payload: {} })).json();
      await app.inject({
        method: "POST",
        url: `/agent/sessions/${s.id}/rules`,
        headers: auth,
        payload: { tool: "do_write", decision: "deny" },
      });
      await app.inject({
        method: "PATCH",
        url: `/agent/sessions/${s.id}`,
        headers: auth,
        payload: { permissionMode: "bypass" },
      });
      await app.inject({
        method: "POST",
        url: `/agent/sessions/${s.id}/chat`,
        headers: auth,
        payload: { message: "write it" },
      });
      expect(writeCall).toHaveBeenCalled(); // bypass = the member's explicit standing choice — rules don't apply
      await app.close();
    });

    it("an explicit body.mode overrides the session's standing mode for that turn", async () => {
      const writeCall = vi.fn(async () => ({ content: "wrote", isError: false }));
      const app = buildServer(makeDeps(writeToolDeps(writeCall)));
      const s = (await app.inject({ method: "POST", url: "/agent/sessions", headers: auth, payload: {} })).json();
      await app.inject({
        method: "PATCH",
        url: `/agent/sessions/${s.id}`,
        headers: auth,
        payload: { permissionMode: "bypass" },
      });
      await app.inject({
        method: "POST",
        url: `/agent/sessions/${s.id}/chat`,
        headers: auth,
        payload: { message: "write it", mode: "plan" }, // one-off plan turn wins over the standing bypass
      });
      expect(writeCall).not.toHaveBeenCalled();
      await app.close();
    });
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

  it("folds the open analysis canvas into the model's user turn so NL refinement grounds on the live state", async () => {
    const seenUserTurns: string[] = [];
    const transport: LlmTransport = {
      provider: "fake",
      stream: async (req) => {
        const user = [...req.messages].reverse().find((m) => m.role === "user");
        if (user && typeof user.content === "string") seenUserTurns.push(user.content);
        return {
          content: "ok",
          toolCalls: [],
          finishReason: "stop",
          usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
        };
      },
    };
    const app = buildServer(makeDeps({ resolveModel: async () => ({ transport, model: "test-model" }) }));
    const session = (await app.inject({ method: "POST", url: "/agent/sessions", headers: auth, payload: {} })).json();
    await app.inject({
      method: "POST",
      url: `/agent/sessions/${session.id}/chat`,
      headers: auth,
      payload: {
        message: "make it a bar chart",
        canvas: { config: { group: "harness", viz: "table", measure: "passRate" }, viewId: "view-1" },
      },
    });
    const turn = seenUserTurns.at(-1);
    expect(turn).toContain('"viz":"table"');
    expect(turn).toContain("view-1");
    expect(turn).toContain("apply_view_config");
    // Saving closes in-conversation too: an open saved View steers to update_view (create_view when unsaved).
    expect(turn).toContain("update_view");
    expect(turn).toContain("User message:\nmake it a bar chart");
    // The persisted user record keeps the clean text — the canvas context is model-facing only.
    const messages = (
      await app.inject({ method: "GET", url: `/agent/sessions/${session.id}/messages`, headers: auth })
    ).json().messages as { role: string; content: string }[];
    expect(messages.find((m) => m.role === "user")?.content).toBe("make it a bar chart");
    await app.close();
  });

  it("tells the model the analysis canvas is EMPTY so a new analysis gets its first lens drawn", async () => {
    const seenUserTurns: string[] = [];
    const transport: LlmTransport = {
      provider: "fake",
      stream: async (req) => {
        const user = [...req.messages].reverse().find((m) => m.role === "user");
        if (user && typeof user.content === "string") seenUserTurns.push(user.content);
        return {
          content: "ok",
          toolCalls: [],
          finishReason: "stop",
          usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
        };
      },
    };
    const app = buildServer(makeDeps({ resolveModel: async () => ({ transport, model: "test-model" }) }));
    const session = (await app.inject({ method: "POST", url: "/agent/sessions", headers: auth, payload: {} })).json();
    // The blank studio canvas (the "new analysis" entry) announces an EMPTY config — it has no pickers, so nothing appears on it
    // until the agent applies a lens. "{}" alone would read as "an analysis that happens to be empty".
    await app.inject({
      method: "POST",
      url: `/agent/sessions/${session.id}/chat`,
      headers: auth,
      payload: { message: "what should we look at first?", canvas: { config: {} } },
    });
    const turn = seenUserTurns.at(-1);
    expect(turn).toContain("EMPTY");
    expect(turn).toContain("apply_view_config");
    expect(turn).toContain("create_view");
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

  // A live turn is decoupled from the request that started it: it is keyed per session (409 on a duplicate),
  // re-attachable (GET /stream) and explicitly stoppable (POST /stop) — the regression suite for the "switching
  // conversations looked idle and double-ran the turn" defect.
  describe("live turns", () => {
    // A transport gated on an external release — the turn stays LIVE until the test releases it, so concurrency
    // (409 / live flag / re-attach) is exercised deterministically. Abort-aware: /stop settles the pending call.
    function gatedTransport(text: string) {
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      let started!: () => void;
      const startedPromise = new Promise<void>((r) => {
        started = r;
      });
      const transport: LlmTransport = {
        provider: "fake",
        stream: async (req) => {
          req.onContentDelta?.(text);
          started();
          await new Promise<void>((resolve) => {
            void gate.then(resolve);
            req.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          return {
            content: text,
            toolCalls: [],
            finishReason: "stop",
            usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
          };
        },
      };
      return { transport, release, started: startedPromise };
    }

    it("refuses a second turn while one is live (409) and reports the session as live", async () => {
      const gated = gatedTransport("streaming answer");
      const app = buildServer(makeDeps({ resolveModel: async () => ({ transport: gated.transport, model: "m" }) }));
      const session = (await app.inject({ method: "POST", url: "/agent/sessions", headers: auth, payload: {} })).json();

      const first = app.inject({
        method: "POST",
        url: `/agent/sessions/${session.id}/chat`,
        headers: { ...auth, accept: "text/event-stream" },
        payload: { message: "go" },
      });
      await gated.started;

      // The session list + detail both carry the computed live flag while the turn runs.
      const listed = (await app.inject({ method: "GET", url: "/agent/sessions", headers: auth })).json().sessions as {
        id: string;
        live?: boolean;
      }[];
      expect(listed.find((s) => s.id === session.id)?.live).toBe(true);
      expect(
        (await app.inject({ method: "GET", url: `/agent/sessions/${session.id}`, headers: auth })).json().live,
      ).toBe(true);

      // A concurrent turn on the same session is refused — the duplicate-turn guard.
      const dup = await app.inject({
        method: "POST",
        url: `/agent/sessions/${session.id}/chat`,
        headers: auth,
        payload: { message: "again" },
      });
      expect(dup.statusCode).toBe(409);

      gated.release();
      const done = await first;
      expect(done.statusCode).toBe(200);
      expect(done.payload).toContain("event: done");

      // Settled: the flag is gone and the refused duplicate never reached the transcript.
      const after = (await app.inject({ method: "GET", url: `/agent/sessions/${session.id}`, headers: auth })).json();
      expect(after.live).toBeUndefined();
      const roles = (
        await app.inject({ method: "GET", url: `/agent/sessions/${session.id}/messages`, headers: auth })
      ).json().messages as { role: string }[];
      expect(roles.map((m) => m.role)).toEqual(["user", "assistant"]);
      await app.close();
    });

    it("a late attacher replays the in-flight bubble and follows the turn to done (GET /stream)", async () => {
      const gated = gatedTransport("partial text");
      const app = buildServer(makeDeps({ resolveModel: async () => ({ transport: gated.transport, model: "m" }) }));
      const session = (await app.inject({ method: "POST", url: "/agent/sessions", headers: auth, payload: {} })).json();
      const first = app.inject({
        method: "POST",
        url: `/agent/sessions/${session.id}/chat`,
        headers: { ...auth, accept: "text/event-stream" },
        payload: { message: "go" },
      });
      await gated.started;

      const watcher = app.inject({ method: "GET", url: `/agent/sessions/${session.id}/stream`, headers: auth });
      // Give the watcher a beat to authenticate + subscribe before the turn settles.
      await new Promise((r) => setTimeout(r, 50));
      gated.release();
      const [chatRes, watchRes] = await Promise.all([first, watcher]);
      expect(chatRes.statusCode).toBe(200);
      expect(watchRes.statusCode).toBe(200);
      // The delta emitted BEFORE the attach arrives via the snapshot replay; the terminal done closes the stream.
      expect(watchRes.payload).toContain("event: delta");
      expect(watchRes.payload).toContain("partial text");
      expect(watchRes.payload).toContain("event: done");

      // Nothing live anymore → a fresh attach answers 204 (the panel stays idle).
      expect(
        (await app.inject({ method: "GET", url: `/agent/sessions/${session.id}/stream`, headers: auth })).statusCode,
      ).toBe(204);
      await app.close();
    });

    it("POST /stop aborts the live turn — the explicit stop that replaced disconnect-as-stop", async () => {
      const gated = gatedTransport("never finishes on its own");
      const app = buildServer(makeDeps({ resolveModel: async () => ({ transport: gated.transport, model: "m" }) }));
      const session = (await app.inject({ method: "POST", url: "/agent/sessions", headers: auth, payload: {} })).json();
      const first = app.inject({
        method: "POST",
        url: `/agent/sessions/${session.id}/chat`,
        headers: { ...auth, accept: "text/event-stream" },
        payload: { message: "go" },
      });
      await gated.started;

      const stopped = await app.inject({
        method: "POST",
        url: `/agent/sessions/${session.id}/stop`,
        headers: auth,
        payload: {},
      });
      expect(stopped.statusCode).toBe(200);
      expect(stopped.json().ok).toBe(true);

      // The abort settles the loop and the SSE response ends.
      const done = await first;
      expect(done.statusCode).toBe(200);

      // Nothing live anymore → stop reports 404.
      expect(
        (await app.inject({ method: "POST", url: `/agent/sessions/${session.id}/stop`, headers: auth, payload: {} }))
          .statusCode,
      ).toBe(404);
      await app.close();
    });

    it("POST /stop hands back the queued message it cancelled instead of leaving it for a later turn", async () => {
      // Given: a live turn with a steering message queued behind it — the shape of a redirect the member sends
      // while an answer is streaming.
      const gated = gatedTransport("mid-answer");
      const app = buildServer(makeDeps({ resolveModel: async () => ({ transport: gated.transport, model: "m" }) }));
      const session = (await app.inject({ method: "POST", url: "/agent/sessions", headers: auth, payload: {} })).json();
      const first = app.inject({
        method: "POST",
        url: `/agent/sessions/${session.id}/chat`,
        headers: { ...auth, accept: "text/event-stream" },
        payload: { message: "go" },
      });
      await gated.started;
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/agent/sessions/${session.id}/input`,
            headers: auth,
            payload: { message: "actually, check the other dataset" },
          })
        ).statusCode,
      ).toBe(202);

      // When: the member stops the turn before the loop ever reaches the boundary that would absorb it.
      const stopped = await app.inject({
        method: "POST",
        url: `/agent/sessions/${session.id}/stop`,
        headers: auth,
        payload: {},
      });
      await first;

      // Then: the cancelled message comes back to the caller (it goes into the composer, not into thin air)…
      expect(stopped.statusCode).toBe(200);
      expect(stopped.json().dropped).toEqual(["actually, check the other dataset"]);

      // …and it is GONE from the mailbox, so the next turn answers what was actually asked. Before this, an
      // undrained redirect silently prepended itself to a later, unrelated turn.
      gated.release();
      const next = await app.inject({
        method: "POST",
        url: `/agent/sessions/${session.id}/chat`,
        headers: auth,
        payload: { message: "unrelated question" },
      });
      expect(next.statusCode).toBe(200);
      const contents = (next.json().messages as { content: string }[]).map((m) => m.content);
      expect(contents).not.toContain("actually, check the other dataset");
      await app.close();
    });

    it("a stopped turn keeps its partial answer and says it was interrupted", async () => {
      // Given: a live turn that has streamed the opening of an answer. Unlike gatedTransport this one THROWS on
      // abort — what a real provider stream does when the socket is cut, which is the path a stop actually takes.
      let started!: () => void;
      const startedPromise = new Promise<void>((r) => {
        started = r;
      });
      const transport: LlmTransport = {
        provider: "fake",
        stream: (req) =>
          new Promise((_resolve, reject) => {
            req.onContentDelta?.("half an answer");
            started();
            req.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
      };
      const app = buildServer(makeDeps({ resolveModel: async () => ({ transport, model: "m" }) }));
      const session = (await app.inject({ method: "POST", url: "/agent/sessions", headers: auth, payload: {} })).json();
      const first = app.inject({
        method: "POST",
        url: `/agent/sessions/${session.id}/chat`,
        headers: { ...auth, accept: "text/event-stream" },
        payload: { message: "go" },
      });
      await startedPromise;

      // When: they stop it.
      await app.inject({ method: "POST", url: `/agent/sessions/${session.id}/stop`, headers: auth, payload: {} });
      await first;

      // Then: the transcript is [what they asked, what they READ, why it stopped]. A cancelled turn used to
      // leave neither of the last two — the history ended on an unanswered user turn, so the panel showed a
      // hole and the next turn stacked a second user message straight onto the first.
      const listed = (
        await app.inject({ method: "GET", url: `/agent/sessions/${session.id}/messages`, headers: auth })
      ).json().messages as { role: string; content: string }[];
      expect(listed.map((m) => [m.role, m.content])).toEqual([
        ["user", "go"],
        ["assistant", "half an answer"],
        ["assistant", INTERRUPTED_BY_USER],
      ]);
      await app.close();
    });
  });
});
