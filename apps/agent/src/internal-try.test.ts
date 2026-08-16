import { ToolRegistry } from "@everdict/agent-runtime";
import { InMemoryAgentSessionStore, InMemoryTenantKeyStore } from "@everdict/db";
import type { LlmTransport } from "@everdict/llm";
import { describe, expect, it } from "vitest";
import type { ForwardHeaders } from "./principal.js";
import { type AgentServerDeps, buildServer } from "./server.js";

// POST /internal/try — the service-to-service try-drive behind the control plane's `try_agent` MCP tool
// (the self-evolution loop's evaluate step). Three properties it must not quietly relax: the internal token
// gates it, the loop's tools run under a ONE-SHOT agt_ credential minted for the named member, and that
// credential does not outlive the try.

const idle: LlmTransport = {
  provider: "fake",
  stream: async () => ({
    content: "shadow answer",
    toolCalls: [],
    finishReason: "stop",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  }),
} as unknown as LlmTransport;

function deps(keyStore: InMemoryTenantKeyStore, seen: ForwardHeaders[]): AgentServerDeps {
  let n = 0;
  return {
    authenticate: async () => ({ subject: "member-1", workspace: "acme", roles: ["member"] }),
    sessions: new InMemoryAgentSessionStore(),
    keyStore,
    internalToken: "shhh",
    resolveModel: async () => ({ transport: idle, model: "test-model" }),
    toolProvider: async (headers: ForwardHeaders) => {
      seen.push(headers);
      return { registry: new ToolRegistry([]), call: null, close: async () => {} };
    },
    systemPrompt: "test",
    now: () => "2026-08-16T00:00:00.000Z",
    newId: () => `id-${n++}`,
  } as unknown as AgentServerDeps;
}

const body = {
  workspace: "acme",
  subject: "member-1",
  draft: { instructions: "candidate instructions", task: "answer the event" },
  event: { kind: "scorecard.completed", message: "scorecard sc-1 completed" },
};

describe("POST /internal/try", () => {
  it("refuses a caller without the internal token", async () => {
    const app = buildServer(deps(new InMemoryTenantKeyStore(), []));
    const res = await app.inject({ method: "POST", url: "/internal/try", payload: body });
    expect(res.statusCode).toBe(401);
  });

  it("refuses a body that names no acting member", async () => {
    const app = buildServer(deps(new InMemoryTenantKeyStore(), []));
    const res = await app.inject({
      method: "POST",
      url: "/internal/try",
      headers: { "x-internal-token": "shhh" },
      payload: { workspace: "acme", event: body.event },
    });
    expect(res.statusCode).toBe(400);
  });

  it("runs the shadow try under a one-shot agt_ token and revokes it after", async () => {
    const keyStore = new InMemoryTenantKeyStore();
    const seen: ForwardHeaders[] = [];
    const app = buildServer(deps(keyStore, seen));
    const res = await app.inject({
      method: "POST",
      url: "/internal/try",
      headers: { "x-internal-token": "shhh" },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    const result = res.json() as { messages: unknown[]; trace: unknown[]; wouldHave: unknown[] };
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.trace.length).toBeGreaterThan(0);
    // The loop's tools were handed the minted agt_ bearer — not the caller's internal token.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.authorization).toMatch(/^Bearer agt_/);
    expect(seen[0]?.workspace).toBe("acme");
    // One-shot: nothing remains in the key store once the try returned.
    expect(await keyStore.list("acme")).toHaveLength(0);
  });

  it("pins a saved agent to the requested version — candidate-version evals, not just the newest row", async () => {
    const resolved: Array<{ agentId?: string; version?: string }> = [];
    const d = deps(new InMemoryTenantKeyStore(), []);
    (d as { resolveProfile?: unknown }).resolveProfile = async (
      _principal: unknown,
      agentId?: string,
      version?: string,
    ) => {
      resolved.push({ ...(agentId !== undefined ? { agentId } : {}), ...(version !== undefined ? { version } : {}) });
      return { systemPrompt: "pinned persona", mcpServers: [], skills: [], codeTools: [] };
    };
    const app = buildServer(d);
    const res = await app.inject({
      method: "POST",
      url: "/internal/try",
      headers: { "x-internal-token": "shhh" },
      payload: { workspace: "acme", subject: "member-1", agentId: "helper", version: "1.2.0", event: body.event },
    });
    expect(res.statusCode).toBe(200);
    expect(resolved).toEqual([{ agentId: "helper", version: "1.2.0" }]);
  });
});
