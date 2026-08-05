import { CommentService, RunService } from "@everdict/application-control";
import type { Principal } from "@everdict/auth";
import type { Dispatcher } from "@everdict/backends";
import { InMemoryCommentStore, InMemoryRunStore } from "@everdict/db";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { type McpDeps, buildMcpServer } from "../../mcp.js";
import type { AgentAttribution } from "../fs/fs-actor.js";

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused in comment tests");
  },
};

function makeDeps(): McpDeps {
  return {
    service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    commentService: new CommentService({ store: new InMemoryCommentStore() }),
  };
}

// `agent` is what mcp.routes.ts reads from the initialize request's headers — one MCP session per conversation.
async function connect(deps: McpDeps, agent?: AgentAttribution): Promise<Client> {
  const principal: Principal = { subject: "user-a", workspace: "acme", roles: ["member"], via: "oidc" };
  const server = buildMcpServer(deps, principal, agent);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await server.connect(serverT);
  await client.connect(clientT);
  return client;
}

function jsonOf(r: unknown): Record<string, unknown> {
  const c = (r as { content?: Array<{ type: string; text?: string }> }).content?.[0];
  return c && c.type === "text" && c.text ? JSON.parse(c.text) : {};
}

const isError = (r: unknown): boolean => (r as { isError?: boolean }).isError === true;

describe("MCP create_comment authorship", () => {
  it("credits the AGENT holding the session, not the member whose credential it carries", async () => {
    // Given a session an agent opened on a member's behalf
    const client = await connect(makeDeps(), { agentId: "triage", agentName: "Triage", conversationId: "conv-9" });
    // When the agent answers on an issue
    const created = jsonOf(
      await client.callTool({
        name: "create_comment",
        arguments: { resource_type: "issue", resource_id: "ENG-12", body: "The regression traces to judge-v3." },
      }),
    );
    // Then the thread shows Everdict, and links back to the conversation behind the answer
    expect(created).toMatchObject({
      author: "everdict:agent",
      authorKind: "agent",
      agentStatus: "complete",
      agentSessionId: "conv-9",
    });
  });

  it("a session with no agent declared (a person's own client) still posts as that member", async () => {
    const client = await connect(makeDeps());
    const created = jsonOf(
      await client.callTool({
        name: "create_comment",
        arguments: { resource_type: "issue", resource_id: "ENG-12", body: "my own note" },
      }),
    );
    expect(created.author).toBe("user-a");
    expect(created.authorKind).toBeUndefined();
  });

  it("an agent asking the discussion agent is refused — it would be answering its own comment", async () => {
    const client = await connect(makeDeps(), { agentId: "triage", conversationId: "conv-9" });
    const res = await client.callTool({
      name: "create_comment",
      arguments: {
        resource_type: "issue",
        resource_id: "ENG-12",
        body: "@everdict take a look",
        ask_agent: true,
      },
    });
    expect(isError(res)).toBe(true);
  });
});
