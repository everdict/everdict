import type { Principal } from "@everdict/auth";
import type { Dispatcher } from "@everdict/backends";
import type { CaseResult } from "@everdict/core";
import {
  InMemoryRunStore,
  InMemoryUserProfileStore,
  InMemoryWorkspaceInviteStore,
  InMemoryWorkspaceStore,
} from "@everdict/db";
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
  await store.create({ id: "solo", name: "Solo", owner: "carol" }); // carol = sole admin
  const profileStore = new InMemoryUserProfileStore(); // share so profile ↔ member-list enrichment see the same store
  return {
    service: new RunService({ dispatcher: okDispatcher, store: new InMemoryRunStore() }),
    profileService: new ProfileService(profileStore),
    membershipService: new MembershipService(store, new InMemoryWorkspaceInviteStore(store), profileStore),
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

function jsonOf(r: unknown): Record<string, unknown> {
  const c = (r as { content?: Array<{ type: string; text?: string }> }).content?.[0];
  return c && c.type === "text" && c.text ? JSON.parse(c.text) : {};
}

describe("MCP profile + leave tools (BFF↔MCP parity)", () => {
  it("update_profile/get_profile are self-serve — edit·read my profile", async () => {
    const me = await connect(await makeDeps(), "dave", "acme");
    const updated = jsonOf(
      await me.callTool({ name: "update_profile", arguments: { name: "Dave", username: "dave" } }),
    );
    expect(updated).toMatchObject({ name: "Dave", username: "dave" });
    const got = jsonOf(await me.callTool({ name: "get_profile", arguments: {} }));
    expect(got).toMatchObject({ name: "Dave", username: "dave" });
  });

  it("update_profile is a tool error on invalid input", async () => {
    const me = await connect(await makeDeps(), "dave", "acme");
    const bad = await me.callTool({ name: "update_profile", arguments: { avatarUrl: "not a url" } });
    expect(bad.isError).toBe(true);
  });

  it("leave_workspace: can leave when there are two admins", async () => {
    const bob = await connect(await makeDeps(), "bob", "acme");
    const left = jsonOf(await bob.callTool({ name: "leave_workspace", arguments: {} }));
    expect(left).toMatchObject({ workspace: "acme", left: true });
  });

  it("leave_workspace: the last admin cannot leave (tool error)", async () => {
    const carol = await connect(await makeDeps(), "carol", "solo");
    const res = await carol.callTool({ name: "leave_workspace", arguments: {} });
    expect(res.isError).toBe(true);
  });
});
