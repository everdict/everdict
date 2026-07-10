import { RunService } from "@everdict/application-control";
import { WorkspaceService } from "@everdict/application-control";
import type { Principal } from "@everdict/auth";
import type { Dispatcher } from "@everdict/backends";
import type { CaseResult } from "@everdict/core";
import { InMemoryRunStore, InMemoryWorkspaceStore } from "@everdict/db";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { type McpDeps, buildMcpServer } from "../../mcp.js";

const result: CaseResult = {
  caseId: "c1",
  harness: "scripted@0",
  trace: [],
  snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
  scores: [],
};
const okDispatcher: Dispatcher = {
  async dispatch() {
    return result;
  },
};

async function makeDeps(): Promise<{ deps: McpDeps; store: InMemoryWorkspaceStore }> {
  const store = new InMemoryWorkspaceStore();
  await store.create({ id: "acme", name: "Acme", owner: "alice" }); // alice = owner+admin
  await store.ensureMembership("acme", "bob", "admin"); // bob = admin but not the owner
  const deps: McpDeps = {
    service: new RunService({ dispatcher: okDispatcher, store: new InMemoryRunStore() }),
    workspaceService: new WorkspaceService(store),
  };
  return { deps, store };
}

async function connect(deps: McpDeps, subject: string, roles: string[]): Promise<Client> {
  const principal: Principal = { subject, workspace: "acme", roles, via: "oidc" };
  const server = buildMcpServer(deps, principal);
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

describe("MCP workspace meta/delete tools (BFF↔MCP parity)", () => {
  it("get_workspace returns the workspace record to an admin", async () => {
    const me = await connect((await makeDeps()).deps, "alice", ["admin"]);
    const got = jsonOf(await me.callTool({ name: "get_workspace", arguments: {} }));
    expect(got).toMatchObject({ id: "acme", name: "Acme", owner: "alice" });
  });

  it("update_workspace lets an admin change the name/logo (data URL)", async () => {
    const me = await connect((await makeDeps()).deps, "alice", ["admin"]);
    const updated = jsonOf(
      await me.callTool({
        name: "update_workspace",
        arguments: { name: "Acme Inc", logoUrl: "data:image/png;base64,iVBORw0KGgo=" },
      }),
    );
    expect(updated).toMatchObject({ name: "Acme Inc", logoUrl: "data:image/png;base64,iVBORw0KGgo=" });
  });

  it("update_workspace is a tool error for a viewer (settings:write gate)", async () => {
    const me = await connect((await makeDeps()).deps, "eve", ["viewer"]);
    const res = await me.callTool({ name: "update_workspace", arguments: { name: "Nope" } });
    expect(res.isError).toBe(true);
  });

  it("delete_workspace deletes the workspace when called by the owner", async () => {
    const { deps, store } = await makeDeps();
    const me = await connect(deps, "alice", ["admin"]);
    const res = jsonOf(await me.callTool({ name: "delete_workspace", arguments: {} }));
    expect(res).toMatchObject({ workspace: "acme", deleted: true });
    expect(await store.get("acme")).toBeUndefined();
  });

  it("delete_workspace is a tool error for a non-owner (even another admin can't)", async () => {
    const { deps, store } = await makeDeps();
    const bob = await connect(deps, "bob", ["admin"]);
    const res = await bob.callTool({ name: "delete_workspace", arguments: {} });
    expect(res.isError).toBe(true);
    expect(await store.get("acme")).toBeDefined();
  });
});
