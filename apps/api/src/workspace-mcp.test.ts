import type { Principal } from "@assay/auth";
import type { Dispatcher } from "@assay/backends";
import type { CaseResult } from "@assay/core";
import { InMemoryRunStore, InMemoryWorkspaceStore } from "@assay/db";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { type McpDeps, buildMcpServer } from "./mcp.js";
import { RunService } from "./run-service.js";
import { WorkspaceService } from "./workspace-service.js";

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
  await store.ensureMembership("acme", "bob", "admin"); // bob = admin 이지만 owner 아님
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

describe("MCP workspace 메타/삭제 도구 (BFF↔MCP 패리티)", () => {
  it("get_workspace 는 admin 에게 워크스페이스 레코드를 돌려준다", async () => {
    const me = await connect((await makeDeps()).deps, "alice", ["admin"]);
    const got = jsonOf(await me.callTool({ name: "get_workspace", arguments: {} }));
    expect(got).toMatchObject({ id: "acme", name: "Acme", owner: "alice" });
  });

  it("update_workspace 는 admin 이 이름/로고(data URL)를 바꾼다", async () => {
    const me = await connect((await makeDeps()).deps, "alice", ["admin"]);
    const updated = jsonOf(
      await me.callTool({
        name: "update_workspace",
        arguments: { name: "Acme Inc", logoUrl: "data:image/png;base64,iVBORw0KGgo=" },
      }),
    );
    expect(updated).toMatchObject({ name: "Acme Inc", logoUrl: "data:image/png;base64,iVBORw0KGgo=" });
  });

  it("update_workspace 는 viewer 면 도구 에러(settings:write 게이트)", async () => {
    const me = await connect((await makeDeps()).deps, "eve", ["viewer"]);
    const res = await me.callTool({ name: "update_workspace", arguments: { name: "Nope" } });
    expect(res.isError).toBe(true);
  });

  it("delete_workspace 는 owner 면 워크스페이스를 지운다", async () => {
    const { deps, store } = await makeDeps();
    const me = await connect(deps, "alice", ["admin"]);
    const res = jsonOf(await me.callTool({ name: "delete_workspace", arguments: {} }));
    expect(res).toMatchObject({ workspace: "acme", deleted: true });
    expect(await store.get("acme")).toBeUndefined();
  });

  it("delete_workspace 는 owner 가 아니면 도구 에러(다른 admin 도 불가)", async () => {
    const { deps, store } = await makeDeps();
    const bob = await connect(deps, "bob", ["admin"]);
    const res = await bob.callTool({ name: "delete_workspace", arguments: {} });
    expect(res.isError).toBe(true);
    expect(await store.get("acme")).toBeDefined();
  });
});
