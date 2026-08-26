import { IssueService, RunService } from "@everdict/application-control";
import type { Principal } from "@everdict/auth";
import type { Dispatcher } from "@everdict/backends";
import { InMemoryIssueStore, InMemoryRunStore, InMemoryScorecardStore } from "@everdict/db";
import { InMemoryAgentRegistry } from "@everdict/registry";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { AgentService } from "../../core/agent/agent-service.js";
import { type McpDeps, buildMcpServer } from "../../mcp.js";

// save_agent origin over MCP — the tool twin of the PUT /agents/:id origin tests (review wave C, test#5):
// the evolve loop adopts a winning candidate through THIS tool, so the declared issue must land as the
// version's origin the same way the HTTP door records it (BFF↔MCP parity).

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused in agent-save MCP tests");
  },
};

const AGENT = JSON.stringify({
  description: "workspace assistant",
  instructions: "be brief",
  mcpServers: [],
  capabilities: [],
  tags: [],
});

function makeDeps(): { deps: McpDeps; agents: InMemoryAgentRegistry; issues: IssueService } {
  const agents = new InMemoryAgentRegistry();
  const issues = new IssueService({
    teams: {
      async allocateForIssue() {
        return { team: { id: "team-eng" }, grant: { number: 1, identifier: "ENG-1" } };
      },
    },
    store: new InMemoryIssueStore(),
    scorecards: new InMemoryScorecardStore(),
  });
  const deps: McpDeps = {
    service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    agentRegistry: agents,
    agentService: new AgentService({ agents }),
    issueService: issues,
  };
  return { deps, agents, issues };
}

async function connect(deps: McpDeps): Promise<Client> {
  const principal: Principal = { subject: "user-a", workspace: "acme", roles: ["member"], via: "oidc" };
  const server = buildMcpServer(deps, principal);
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

describe("save_agent origin — the MCP save records the declared issue, and a bump its base", () => {
  it("a fresh save with fromIssue stamps via 'mcp' and the resolved issue (born_from intent)", async () => {
    const { deps, agents, issues } = makeDeps();
    const issue = await issues.create({ tenant: "acme", title: "Judge misses truncated answers", createdBy: "user-a" });
    const client = await connect(deps);
    const saved = await client.callTool({
      name: "save_agent",
      arguments: { id: "helper", agent: AGENT, fromIssue: issue.identifier, originNote: "campaign winner" },
    });
    expect(saved.isError).toBeFalsy();
    expect(JSON.parse(textOf(saved))).toMatchObject({ id: "helper", version: "1.0.0", created: true });
    const entry = (await agents.list("acme")).find((e) => e.id === "helper");
    expect(entry?.versionOrigins?.["1.0.0"]).toMatchObject({
      via: "mcp",
      from: { type: "issue", id: issue.id },
      note: "campaign winner",
    });
  });

  it("a bump through the tool records the base version it succeeds — never the caller's story", async () => {
    const { deps, agents } = makeDeps();
    const client = await connect(deps);
    await client.callTool({ name: "save_agent", arguments: { id: "helper", agent: AGENT } });
    const edited = JSON.stringify({ ...JSON.parse(AGENT), instructions: "be brief and cite ids" });
    const bumped = await client.callTool({ name: "save_agent", arguments: { id: "helper", agent: edited } });
    expect(bumped.isError).toBeFalsy();
    expect(JSON.parse(textOf(bumped))).toMatchObject({ version: "1.0.1", created: true });
    const entry = (await agents.list("acme")).find((e) => e.id === "helper");
    expect(entry?.versionOrigins?.["1.0.1"]).toMatchObject({
      via: "mcp",
      from: { type: "agent", id: "helper", version: "1.0.0" },
    });
  });
});
