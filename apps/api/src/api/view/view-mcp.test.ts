import { RevisionedWorkspaceFs, RunService, ViewService, ViewSnapshotService } from "@everdict/application-control";
import type { Principal } from "@everdict/auth";
import type { Dispatcher } from "@everdict/backends";
import type { ScorecardRecord } from "@everdict/contracts";
import { InMemoryFsRevisionStore, InMemoryRunStore, InMemoryScorecardStore, InMemoryViewStore } from "@everdict/db";
import { InMemoryWorkspaceFs } from "@everdict/storage";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { type McpDeps, buildMcpServer } from "../../mcp.js";

// BFF↔MCP parity for view captures: the agent reaches the same service the HTTP route does, and the file it
// produces is readable with the fs tools it already has — which is the whole point of accumulating on the
// filesystem rather than in a private store.

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused in view tests");
  },
};

const scorecard: ScorecardRecord = {
  id: "sc-1",
  tenant: "acme",
  dataset: { id: "smoke", version: "1.0.0" },
  harness: { id: "hermes", version: "1.0.0" },
  status: "succeeded",
  summary: [{ metric: "judge", count: 12, mean: 0.75, passRate: 0.75 }],
  steps: [],
  createdAt: "2026-06-01T00:00:00Z",
  updatedAt: "2026-06-01T00:00:00Z",
} as ScorecardRecord;

async function makeDeps(): Promise<{ deps: McpDeps; viewId: string }> {
  const ledger = new InMemoryFsRevisionStore();
  const fs = new RevisionedWorkspaceFs(new InMemoryWorkspaceFs(), ledger);
  const views = new InMemoryViewStore();
  const scorecards = new InMemoryScorecardStore();
  await scorecards.create(scorecard);
  const viewService = new ViewService({ store: views });
  const created = await viewService.create({
    tenant: "acme",
    createdBy: "user-a",
    name: "Pass rate by harness",
    config: { group: "harness", measure: "passRate" },
    visibility: "workspace",
  });
  return {
    deps: {
      service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
      viewService,
      viewSnapshotService: new ViewSnapshotService({ views, scorecards, fs }),
    },
    viewId: created.id,
  };
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

describe("view snapshot MCP tool", () => {
  it("exposes capture_view_snapshot when the service is composed", async () => {
    const { deps } = await makeDeps();
    const client = await connect(deps);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("capture_view_snapshot");
  });

  it("captures through the same service as the route, and the file is readable with the fs tools", async () => {
    const { deps, viewId } = await makeDeps();
    const client = await connect(deps);

    const captured = JSON.parse(
      textOf(await client.callTool({ name: "capture_view_snapshot", arguments: { id: viewId } })),
    );
    expect(captured.path).toMatch(new RegExp(`^views/${viewId}/`));
    expect(captured.totals).toEqual({ scorecards: 1, cases: 12 });
  });

  it("is absent when no snapshot service is composed — the tool list never advertises a dead capability", async () => {
    const { deps } = await makeDeps();
    const { viewSnapshotService: _omitted, ...withoutSnapshots } = deps;
    const client = await connect(withoutSnapshots);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("capture_view_snapshot");
    expect(names).toContain("create_view"); // the rest of the slice is unaffected
  });
});
