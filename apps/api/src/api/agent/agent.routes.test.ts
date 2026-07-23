import { RunService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import { InMemoryRunStore } from "@everdict/db";
import { InMemoryAgentRegistry } from "@everdict/registry";
import { describe, expect, it } from "vitest";
import { AgentService } from "../../core/agent/agent-service.js";
import { buildServer } from "../../server.js";

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused in agent tests");
  },
};

function build(withAgents: boolean) {
  const service = new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() });
  const agentRegistry = new InMemoryAgentRegistry();
  return buildServer({
    service,
    ...(withAgents ? { agentRegistry, agentService: new AgentService({ agents: agentRegistry }) } : {}),
  });
}

const H = { "x-everdict-tenant": "acme" };

describe("agent routes", () => {
  it("returns 404 when the agent registry is not configured", async () => {
    const res = await build(false).inject({ method: "GET", url: "/agents", headers: H });
    expect(res.statusCode).toBe(404);
  });

  it("registers, reads, lists, and soft-deletes a workspace agent (happy path)", async () => {
    const app = build(true);

    const created = await app.inject({
      method: "POST",
      url: "/agents",
      headers: H,
      payload: {
        id: "default",
        version: "1.0.0",
        instructions: "Prefer WebArena scorecards.",
        mcpServers: [{ name: "tools", url: "https://mcp.example.com/mcp", write: true }],
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ workspace: "acme", id: "default", version: "1.0.0" });

    const got = await app.inject({ method: "GET", url: "/agents/default/versions/latest", headers: H });
    expect(got.statusCode).toBe(200);
    const spec = got.json() as { instructions: string; mcpServers: Array<{ name: string; write: boolean }> };
    expect(spec.instructions).toBe("Prefer WebArena scorecards.");
    expect(spec.mcpServers).toEqual([{ name: "tools", url: "https://mcp.example.com/mcp", write: true }]);

    const list = await app.inject({ method: "GET", url: "/agents", headers: H });
    expect((list.json() as Array<{ id: string }>).map((a) => a.id)).toEqual(["default"]);

    const del = await app.inject({ method: "DELETE", url: "/agents/default/versions/1.0.0", headers: H });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toMatchObject({ deleted: true });
    // Tombstoned → gone from reads.
    const after = await app.inject({ method: "GET", url: "/agents/default/versions/latest", headers: H });
    expect(after.statusCode).toBe(404);
  });

  it("saves an agent as a version-free upsert: new id → 1.0.0, a change bumps, an unchanged spec is a no-op", async () => {
    const app = build(true);

    const first = await app.inject({
      method: "PUT",
      url: "/agents/default",
      headers: H,
      payload: { instructions: "A" },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ id: "default", version: "1.0.0", created: true });

    // A changed spec auto patch-bumps to a new immutable version.
    const changed = await app.inject({
      method: "PUT",
      url: "/agents/default",
      headers: H,
      payload: { instructions: "B" },
    });
    expect(changed.json()).toMatchObject({ version: "1.0.1", created: true });

    // The same spec is an idempotent no-op (no version spam).
    const again = await app.inject({
      method: "PUT",
      url: "/agents/default",
      headers: H,
      payload: { instructions: "B" },
    });
    expect(again.json()).toMatchObject({ version: "1.0.1", created: false });
  });

  it("dry-run validate reports schema outcome + version collision without registering", async () => {
    const app = build(true);
    await app.inject({ method: "POST", url: "/agents", headers: H, payload: { id: "default", version: "1.0.0" } });

    const validated = await app.inject({
      method: "POST",
      url: "/agents/validate",
      headers: H,
      payload: { id: "default", version: "1.0.0", instructions: "x" },
    });
    expect(validated.json()).toMatchObject({ ok: true, versionExists: true, existingVersions: ["1.0.0"] });
  });
});
