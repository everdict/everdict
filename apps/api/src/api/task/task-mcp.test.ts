import { RunService, TaskService } from "@everdict/application-control";
import type { EmitPlatformEventInput } from "@everdict/application-control";
import type { Principal } from "@everdict/auth";
import type { Dispatcher } from "@everdict/backends";
import { InMemoryAgentTaskStore, InMemoryRunStore } from "@everdict/db";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { type McpDeps, buildMcpServer } from "../../mcp.js";

// BFF↔MCP parity for the task ledger — the transport agents actually coordinate through. The agent attribution
// bound at initialize rides into the service, so an agent-created task stamps causedBy (the trigger loop guard).

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused in task tests");
  },
};

function makeDeps(): { deps: McpDeps; emitted: EmitPlatformEventInput[] } {
  const emitted: EmitPlatformEventInput[] = [];
  return {
    deps: {
      service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
      taskService: new TaskService({
        store: new InMemoryAgentTaskStore(),
        events: {
          emit: async (input) => {
            emitted.push(input);
          },
        },
      }),
    },
    emitted,
  };
}

async function connect(deps: McpDeps, agent?: { agentId: string; conversationId?: string }): Promise<Client> {
  const principal: Principal = { subject: "user-a", workspace: "acme", roles: ["member"], via: "oidc" };
  const server = buildMcpServer(deps, principal, agent);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await server.connect(serverT);
  await client.connect(clientT);
  return client;
}

const textOf = (result: unknown): string => {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.map((c) => c.text ?? "").join("");
};

describe("task ledger MCP tools", () => {
  it("exposes the tool family when the service is composed", async () => {
    const { deps } = makeDeps();
    const client = await connect(deps);
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const name of ["create_task", "list_tasks", "get_task", "update_task", "delete_task"]) {
      expect(names).toContain(name);
    }
  });

  it("an agent session's create stamps causedBy, and completing emits the dependency-cleared fact", async () => {
    const { deps, emitted } = makeDeps();
    const client = await connect(deps, { agentId: "triage-bot", conversationId: "conv-1" });
    // When the agent creates a task through its own transport
    const created = JSON.parse(
      textOf(await client.callTool({ name: "create_task", arguments: { subject: "verify the fix" } })),
    );
    expect(created.origin).toEqual({ agentId: "triage-bot", conversationId: "conv-1" });
    expect(emitted[0]).toMatchObject({ kind: "task.created", causedBy: "agent:triage-bot:conv-1" });
    // And completes it
    const completed = JSON.parse(
      textOf(await client.callTool({ name: "update_task", arguments: { id: created.id, status: "completed" } })),
    );
    expect(completed.status).toBe("completed");
    expect(emitted[1]).toMatchObject({ kind: "task.completed", causedBy: "agent:triage-bot:conv-1" });
    // And the ledger reads back through the same surface
    const listed = JSON.parse(textOf(await client.callTool({ name: "list_tasks", arguments: {} })));
    expect(listed).toHaveLength(1);
  });

  it("completing with output hands the report to whoever waits, and the fact's payload names the task id (LESSON 059 P1)", async () => {
    const { deps, emitted } = makeDeps();
    const client = await connect(deps, { agentId: "worker", conversationId: "conv-2" });
    const created = JSON.parse(
      textOf(await client.callTool({ name: "create_task", arguments: { subject: "run the baseline" } })),
    );
    // The wait filter a delegating conversation parks with matches PAYLOAD fields — the id must be there.
    expect(emitted[0]).toMatchObject({ kind: "task.created", payload: { id: created.id } });
    const completed = JSON.parse(
      textOf(
        await client.callTool({
          name: "update_task",
          arguments: { id: created.id, status: "completed", output: "Pass rate 84% — two auth regressions." },
        }),
      ),
    );
    expect(completed.output).toContain("84%");
    expect(emitted[1]).toMatchObject({ kind: "task.completed", payload: { id: created.id } });
    // And the requester's post-wake read sees the report
    const fetched = JSON.parse(textOf(await client.callTool({ name: "get_task", arguments: { id: created.id } })));
    expect(fetched.output).toContain("84%");
  });
});
