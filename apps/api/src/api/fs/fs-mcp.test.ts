import { FsService, RevisionedWorkspaceFs, RunService } from "@everdict/application-control";
import type { Principal } from "@everdict/auth";
import type { Dispatcher } from "@everdict/backends";
import { InMemoryFsRevisionStore, InMemoryRunStore } from "@everdict/db";
import { InMemoryWorkspaceFs } from "@everdict/storage";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { type McpDeps, buildMcpServer } from "../../mcp.js";
import type { AgentAttribution } from "./fs-actor.js";

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused in fs tests");
  },
};

// The composition main.ts wires: the filesystem WRAPPED in versioning, sharing one ledger with the service.
function makeDeps(): McpDeps {
  const ledger = new InMemoryFsRevisionStore();
  return {
    service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    fsService: new FsService(new RevisionedWorkspaceFs(new InMemoryWorkspaceFs(), ledger), ledger),
  };
}

// `agent` is what mcp.routes.ts reads from the initialize request's headers — one MCP session per conversation.
async function connect(deps: McpDeps, opts: { roles?: string[]; agent?: AgentAttribution } = {}): Promise<Client> {
  const principal: Principal = {
    subject: "user-a",
    workspace: "acme",
    roles: opts.roles ?? ["member"],
    via: "oidc",
  };
  const server = buildMcpServer(deps, principal, opts.agent);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await server.connect(serverT);
  await client.connect(clientT);
  return client;
}

const call = async (client: Client, name: string, args: Record<string, unknown> = {}): Promise<unknown> =>
  client.callTool({ name, arguments: args });

function jsonOf(r: unknown): Record<string, unknown> {
  const c = (r as { content?: Array<{ type: string; text?: string }> }).content?.[0];
  return c && c.type === "text" && c.text ? JSON.parse(c.text) : {};
}

const textOf = (r: unknown): string =>
  ((r as { content?: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? "").join("\n");

const isError = (r: unknown): boolean => (r as { isError?: boolean }).isError === true;

describe("MCP file-revision tools (BFF↔MCP parity)", () => {
  it("attributes what the session writes to the AGENT holding it, not to the member", async () => {
    // Given a session opened by an agent on a member's behalf
    const deps = makeDeps();
    const client = await connect(deps, {
      agent: { agentId: "analyst", agentName: "Analyst", conversationId: "sess-42" },
    });
    // When the agent writes a file
    await call(client, "write_file", { path: "reports/q3.md", content: "# Q3" });
    // Then the history credits the agent, and remembers whom it acted for
    const history = jsonOf(await call(client, "list_file_revisions", { path: "reports/q3.md" })) as unknown as Array<
      Record<string, unknown>
    >;
    expect(history[0]).toMatchObject({
      revision: 1,
      actor: {
        kind: "agent",
        agentId: "analyst",
        agentName: "Analyst",
        conversationId: "sess-42",
        onBehalfOf: "user-a",
      },
    });
  });

  it("search_files greps content and globs paths — the MCP twin of GET /fs/search", async () => {
    // Given a workspace holding a memory file and a report
    const deps = makeDeps();
    const client = await connect(deps);
    await call(client, "write_file", { path: "memory/cadence.md", content: "Eval report ships every Friday." });
    await call(client, "write_file", { path: "reports/q3.md", content: "Q3 regression report." });
    // When the agent greps for a fact it half-remembers
    const grep = jsonOf(await call(client, "search_files", { pattern: "friday" }));
    // Then it finds the memory file with a line + excerpt, without knowing the path up front
    expect(grep).toMatchObject({
      matches: [{ path: "memory/cadence.md", line: 1 }],
      truncated: false,
    });
    // …and a glob narrows by path alone
    const glob = jsonOf(await call(client, "search_files", { glob: "memory/*.md" }));
    expect((glob as { matches: { path: string }[] }).matches.map((m) => m.path)).toEqual(["memory/cadence.md"]);
  });

  it("records a member's own write as a member edit when no agent is declared", async () => {
    const deps = makeDeps();
    const client = await connect(deps);
    await call(client, "write_file", { path: "notes.md", content: "mine" });
    const history = jsonOf(await call(client, "list_file_revisions", { path: "notes.md" })) as unknown as Array<
      Record<string, unknown>
    >;
    expect(history[0]).toMatchObject({ actor: { kind: "member", subject: "user-a" } });
  });

  it("hands the agent a merge kit instead of letting it overwrite a concurrent publish", async () => {
    // Given the file moved on after the agent read revision 1
    const deps = makeDeps();
    const client = await connect(deps, { agent: { agentId: "analyst", conversationId: "s1" } });
    await call(client, "write_file", { path: "notes.md", content: "line1\nline2\nline3\n" });
    await call(client, "write_file", {
      path: "notes.md",
      content: "line1\nline2 by a member\nline3\n",
      base_revision: 1,
    });
    // When the agent publishes its edit against the revision it read
    const stale = await call(client, "write_file", {
      path: "notes.md",
      content: "line1 by the agent\nline2\nline3\n",
      base_revision: 1,
    });
    // Then the tool ERRORS (so the agent must react) and the message carries the merge that keeps both edits —
    // as a JSON payload the agent can parse straight out of the error, not just prose.
    expect(isError(stale)).toBe(true);
    expect(textOf(stale)).toContain("CONFLICT");
    const kit = JSON.parse(textOf(stale).slice(textOf(stale).indexOf("{"))) as {
      headRevision: number;
      head: { content: string };
      merge: { merged: string; conflicts: unknown[] };
    };
    expect(kit.headRevision).toBe(2);
    expect(kit.head.content).toBe("line1\nline2 by a member\nline3\n");
    expect(kit.merge).toEqual({ merged: "line1 by the agent\nline2 by a member\nline3\n", conflicts: [] });
    // And the agent's retry, declaring what it merged, succeeds
    const retry = await call(client, "write_file", {
      path: "notes.md",
      content: "line1 by the agent\nline2 by a member\nline3\n",
      base_revision: 2,
    });
    expect(isError(retry)).toBe(false);
    expect(jsonOf(retry)).toMatchObject({ revision: 3 });
  });

  it("surfaces the current revision on get_file so an agent can lock onto it", async () => {
    const deps = makeDeps();
    const client = await connect(deps);
    await call(client, "write_file", { path: "notes.md", content: "v1" });
    await call(client, "write_file", { path: "notes.md", content: "v2" });
    const read = jsonOf(await call(client, "get_file", { path: "notes.md" }));
    expect(read).toMatchObject({ entry: { revision: 2 }, content: "v2" });
  });

  it("reads a past revision and restores it as a new attributed revision", async () => {
    const deps = makeDeps();
    const client = await connect(deps);
    await call(client, "write_file", { path: "notes.md", content: "the good version" });
    await call(client, "write_file", { path: "notes.md", content: "the bad version" });
    expect(jsonOf(await call(client, "get_file_revision", { path: "notes.md", revision: 1 }))).toMatchObject({
      content: "the good version",
    });
    const restored = jsonOf(await call(client, "restore_file_revision", { path: "notes.md", revision: 1 }));
    expect(restored).toMatchObject({ revision: 3 });
    expect(jsonOf(await call(client, "get_file", { path: "notes.md" }))).toMatchObject({
      content: "the good version",
    });
  });

  it("hands an agent the delta instead of making it re-read both revisions", async () => {
    // Given a file an agent published and a member then edited
    const deps = makeDeps();
    const client = await connect(deps);
    await call(client, "write_file", { path: "notes.md", content: "intro\nbody\n" });
    await call(client, "write_file", { path: "notes.md", content: "intro\nbody rewritten\n", base_revision: 1 });
    // When the agent asks what changed since the revision it knew
    const diff = jsonOf(await call(client, "diff_file_revisions", { path: "notes.md", from: 1 })) as {
      to: number;
      diff: { added: number; removed: number; hunks: Array<{ lines: Array<{ op: string; text: string }> }> };
    };
    // Then it gets the hunk, not the whole document
    expect(diff.to).toBe(2);
    expect({ added: diff.diff.added, removed: diff.diff.removed }).toEqual({ added: 1, removed: 1 });
    expect(diff.diff.hunks.flatMap((h) => h.lines)).toContainEqual({
      op: "add",
      text: "body rewritten",
      afterLine: 2,
    });
  });

  it("walks a long history backwards with the revision cursor", async () => {
    const deps = makeDeps();
    const client = await connect(deps);
    for (let i = 1; i <= 4; i++) await call(client, "write_file", { path: "log.md", content: `v${i}` });
    const page = jsonOf(await call(client, "list_file_revisions", { path: "log.md", limit: 2 })) as unknown as Array<{
      revision: number;
    }>;
    expect(page.map((r) => r.revision)).toEqual([4, 3]);
    const older = jsonOf(
      await call(client, "list_file_revisions", { path: "log.md", limit: 2, before: 3 }),
    ) as unknown as Array<{ revision: number }>;
    expect(older.map((r) => r.revision)).toEqual([2, 1]);
  });

  it("404s an unknown revision", async () => {
    const deps = makeDeps();
    const client = await connect(deps);
    await call(client, "write_file", { path: "notes.md", content: "x" });
    const missing = await call(client, "get_file_revision", { path: "notes.md", revision: 99 });
    expect(isError(missing)).toBe(true);
    expect(textOf(missing)).toContain("NOT_FOUND");
  });

  it("gates history reads on files:read and restores on files:write", async () => {
    // Given a viewer (read-only)
    const deps = makeDeps();
    const member = await connect(deps);
    await call(member, "write_file", { path: "notes.md", content: "v1" });
    await call(member, "write_file", { path: "notes.md", content: "v2" });
    const viewer = await connect(deps, { roles: ["viewer"] });
    // Then they can inspect history…
    expect(isError(await call(viewer, "list_file_revisions", { path: "notes.md" }))).toBe(false);
    expect(isError(await call(viewer, "get_file_revision", { path: "notes.md", revision: 1 }))).toBe(false);
    // …but cannot roll the file back
    const restore = await call(viewer, "restore_file_revision", { path: "notes.md", revision: 1 });
    expect(isError(restore)).toBe(true);
    expect(textOf(restore)).toContain("FORBIDDEN");
  });

  it("wipes history along with the tree, and only for an admin", async () => {
    // Given a workspace with published history
    const deps = makeDeps();
    const member = await connect(deps);
    await call(member, "write_file", { path: "notes.md", content: "v1" });
    await call(member, "write_file", { path: "notes.md", content: "v2" });
    // Then a member cannot wipe the filesystem (governance = admin)
    expect(isError(await call(member, "delete_all_files"))).toBe(true);
    // And an admin's wipe takes the history with it — no orphaned revisions left behind
    const admin = await connect(deps, { roles: ["admin"] });
    expect(jsonOf(await call(admin, "delete_all_files"))).toMatchObject({ purgedRevisions: 2 });
    expect(jsonOf(await call(admin, "list_file_revisions", { path: "notes.md" }))).toEqual([]);
    expect(isError(await call(admin, "get_file_revision", { path: "notes.md", revision: 1 }))).toBe(true);
  });

  it("reports what published history costs in the usage tool", async () => {
    const deps = makeDeps();
    const client = await connect(deps, { roles: ["admin"] });
    await call(client, "write_file", { path: "notes.md", content: "12345" });
    await call(client, "write_file", { path: "notes.md", content: "1234567890" });
    const usage = jsonOf(await call(client, "get_fs_usage"));
    // The live tree holds ONE file (10 bytes); history holds both revisions (5 + 10)
    expect(usage).toMatchObject({ files: 1, bytes: 10, history: { revisions: 2, bytes: 15 } });
  });
});
