import type { Principal } from "@assay/auth";
import type { Dispatcher } from "@assay/backends";
import type { CaseResult } from "@assay/core";
import {
  InMemoryRunStore,
  InMemoryUserProfileStore,
  InMemoryWorkspaceInviteStore,
  InMemoryWorkspaceStore,
} from "@assay/db";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { type McpDeps, buildMcpServer } from "./mcp.js";
import { MembershipService } from "./membership-service.js";
import { ProfileService } from "./profile-service.js";
import { RunService } from "./run-service.js";

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

async function makeDeps(): Promise<McpDeps> {
  const store = new InMemoryWorkspaceStore();
  await store.create({ id: "acme", name: "Acme", owner: "alice" }); // alice admin
  await store.ensureMembership("acme", "bob", "admin"); // acme = 2 admins
  await store.create({ id: "solo", name: "Solo", owner: "carol" }); // carol = 단독 admin
  return {
    service: new RunService({ dispatcher: okDispatcher, store: new InMemoryRunStore() }),
    profileService: new ProfileService(new InMemoryUserProfileStore()),
    membershipService: new MembershipService(store, new InMemoryWorkspaceInviteStore(store)),
  };
}

async function connect(deps: McpDeps, subject: string, workspace: string): Promise<Client> {
  const principal: Principal = { subject, workspace, roles: ["member"], via: "oidc" };
  const server = buildMcpServer(deps, principal);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await server.connect(serverT);
  await client.connect(clientT);
  return client;
}

function jsonOf(r: { content?: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  const c = r.content?.[0];
  return c && c.type === "text" && c.text ? JSON.parse(c.text) : {};
}

describe("MCP profile + leave 도구 (BFF↔MCP 패리티)", () => {
  it("update_profile/get_profile 는 self-serve — 내 프로필을 수정·조회", async () => {
    const me = await connect(await makeDeps(), "dave", "acme");
    const updated = jsonOf(
      await me.callTool({ name: "update_profile", arguments: { name: "Dave", username: "dave" } }),
    );
    expect(updated).toMatchObject({ name: "Dave", username: "dave" });
    const got = jsonOf(await me.callTool({ name: "get_profile", arguments: {} }));
    expect(got).toMatchObject({ name: "Dave", username: "dave" });
  });

  it("update_profile 는 형식이 틀리면 도구 에러", async () => {
    const me = await connect(await makeDeps(), "dave", "acme");
    const bad = await me.callTool({ name: "update_profile", arguments: { avatarUrl: "not a url" } });
    expect(bad.isError).toBe(true);
  });

  it("leave_workspace: admin 이 둘이면 나갈 수 있다", async () => {
    const bob = await connect(await makeDeps(), "bob", "acme");
    const left = jsonOf(await bob.callTool({ name: "leave_workspace", arguments: {} }));
    expect(left).toMatchObject({ workspace: "acme", left: true });
  });

  it("leave_workspace: 마지막 admin 은 나갈 수 없다(도구 에러)", async () => {
    const carol = await connect(await makeDeps(), "carol", "solo");
    const res = await carol.callTool({ name: "leave_workspace", arguments: {} });
    expect(res.isError).toBe(true);
  });
});
