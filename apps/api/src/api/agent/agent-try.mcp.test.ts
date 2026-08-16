import { RunService } from "@everdict/application-control";
import type { Principal } from "@everdict/auth";
import type { Dispatcher } from "@everdict/backends";
import { InMemoryRunStore } from "@everdict/db";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { type McpDeps, buildMcpServer } from "../../mcp.js";
import type { AgentTryRelayInput } from "../mcp-context.js";

// `try_agent` — the MCP twin of the agent service's try-drive (the self-evolution loop's evaluate step).
// The tool relays WHO the try acts for from the session's principal — never from tool input, or one member
// could burn another member's attribution — and it exists only when a relay is composed.

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused in try_agent tests");
  },
};

function makeDeps(seen: AgentTryRelayInput[]): McpDeps {
  return {
    service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    agentTry: async (input) => {
      seen.push(input);
      return { messages: [], wouldHave: [], trace: [{ ts: "2026-08-16T00:00:00.000Z", kind: "message" }] };
    },
  };
}

async function connect(deps: McpDeps, roles: string[] = ["member"]): Promise<Client> {
  const principal: Principal = { subject: "user-a", workspace: "acme", roles, via: "oidc" };
  const server = buildMcpServer(deps, principal);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await server.connect(serverT);
  await client.connect(clientT);
  return client;
}

const isError = (r: unknown): boolean => (r as { isError?: boolean }).isError === true;

const args = {
  draft: { instructions: "candidate instructions" },
  event: { kind: "scorecard.completed", message: "scorecard sc-1 completed" },
};

describe("MCP try_agent", () => {
  it("relays the try as the SESSION's member and returns the runtime's result untouched", async () => {
    const seen: AgentTryRelayInput[] = [];
    const client = await connect(makeDeps(seen));
    const res = await client.callTool({ name: "try_agent", arguments: args });
    expect(isError(res)).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.workspace).toBe("acme");
    expect(seen[0]?.subject).toBe("user-a");
    expect(seen[0]?.draft?.instructions).toBe("candidate instructions");
  });

  it("relays a saved agent's version pin", async () => {
    const seen: AgentTryRelayInput[] = [];
    const client = await connect(makeDeps(seen));
    const res = await client.callTool({
      name: "try_agent",
      arguments: { agentId: "helper", version: "1.2.0", event: args.event },
    });
    expect(isError(res)).toBe(false);
    expect(seen[0]?.agentId).toBe("helper");
    expect(seen[0]?.version).toBe("1.2.0");
  });

  it("refuses a caller without agents:write", async () => {
    const seen: AgentTryRelayInput[] = [];
    const client = await connect(makeDeps(seen), ["viewer"]);
    const res = await client.callTool({ name: "try_agent", arguments: args });
    expect(isError(res)).toBe(true);
    expect(seen).toHaveLength(0);
  });

  it("is not offered when no relay is composed", async () => {
    const client = await connect({
      service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    });
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).not.toContain("try_agent");
  });
});
