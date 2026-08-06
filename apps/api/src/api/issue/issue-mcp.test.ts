import {
  CycleService,
  GithubIssueSync,
  InitiativeService,
  IssueService,
  ProjectService,
  RunService,
  TeamService,
} from "@everdict/application-control";
import type { GithubRepoWriter, GithubRepoWriterFactory, OutboxEvent } from "@everdict/application-control";
import type { Principal } from "@everdict/auth";
import type { Dispatcher } from "@everdict/backends";
import {
  InMemoryCycleStore,
  InMemoryInitiativeStore,
  InMemoryInitiativeUpdateStore,
  InMemoryIssueStore,
  InMemoryProjectStore,
  InMemoryRunStore,
  InMemoryScorecardStore,
  InMemoryTeamStore,
} from "@everdict/db";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { type McpDeps, buildMcpServer } from "../../mcp.js";

// BFF↔MCP parity for the eval tracker — the surface an agent triages its own regressions through. The agent
// attribution bound at initialize rides into the service, so an agent's transitions stamp causedBy (loop guard #1).

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused in tracker tests");
  },
};

function makeDeps(): { deps: McpDeps; pushed: OutboxEvent[] } {
  const pushed: OutboxEvent[] = [];
  const issueStore = new InMemoryIssueStore();
  const projectStore = new InMemoryProjectStore();
  const initiativeStore = new InMemoryInitiativeStore();
  const teamStore = new InMemoryTeamStore();
  const events = {
    emit: async () => undefined,
    pushPersisted: async (batch: Array<{ record: OutboxEvent }>) => {
      pushed.push(...batch.map((b) => b.record));
    },
  };
  // A writer that answers nothing — these tests assert the tool SURFACE, not GitHub behaviour (that lives in
  // github-issue-sync.test.ts).
  const idleWriter = new Proxy({} as GithubRepoWriter, {
    get: () => async () => {
      throw new Error("GitHub is not exercised in the MCP surface test");
    },
  });
  const writers: GithubRepoWriterFactory = { for: () => idleWriter };
  // The real team service, so an issue and a project land on the SAME default team — an issue may only join a
  // project its own team is on, and a fake allocator naming a team the project store never heard of would make
  // every tool that puts an issue in a project fail for a reason production does not have.
  const teamService = new TeamService({ store: teamStore, issues: issueStore });
  const cycleStore = new InMemoryCycleStore();
  const issueService = new IssueService({
    teams: teamService,
    store: issueStore,
    scorecards: new InMemoryScorecardStore(),
    projects: projectStore,
    // "Does this cycle exist, and whose is it" — production's wiring, so an agent moving an issue into an
    // iteration meets the same team check a member does.
    cycles: cycleStore,
    events,
  });
  return {
    deps: {
      service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
      issueService,
      teamService,
      cycleService: new CycleService({ store: cycleStore, teams: teamStore, issues: issueStore }),
      issueSync: new GithubIssueSync({
        teams: teamService,
        store: issueStore,
        issues: issueService,
        tokens: { tokenForRepository: async () => ({ token: "tok" }) },
        writers,
      }),
      projectService: new ProjectService({
        store: projectStore,
        issues: issueStore,
        teams: teamStore,
        defaultTeam: teamService,
        // The SAME store the initiative service writes to — a project's initiative edge is validated against
        // the workspace, so a second (empty) store here would reject every real id.
        initiatives: initiativeStore,
        events,
      }),
      initiativeService: new InitiativeService({
        store: initiativeStore,
        projects: projectStore,
        issues: issueStore,
        updates: new InMemoryInitiativeUpdateStore(),
        events,
      }),
    },
    pushed,
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

describe("eval tracker MCP tools", () => {
  it("exposes the full tool family when the services are composed", async () => {
    const client = await connect(makeDeps().deps);
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const name of [
      "create_issue",
      "list_issues",
      "get_issue",
      "update_issue",
      "set_issue_status",
      "add_issue_link",
      "remove_issue_link",
      "list_issue_scorecards",
      "delete_issue",
      "create_project",
      "list_projects",
      "get_project",
      "update_project",
      "set_project_status",
      "post_project_update",
      "list_project_updates",
      "delete_project",
      "create_initiative",
      "list_initiatives",
      "get_initiative",
      "update_initiative",
      "set_initiative_status",
      // The goal's own judgment layer — a family wired into the service but forgotten in mcp.ts would be
      // invisible except here.
      "post_initiative_update",
      "list_initiative_updates",
      "delete_initiative",
    ]) {
      expect(names).toContain(name);
    }
  });

  // The GitHub half is its own optional collaborator (absent when no App is configured), so its parity is
  // asserted separately — a service wired into ServerDeps but forgotten in mcp.ts loses its whole tool family
  // silently, which is exactly how the knowledge tools once went missing.
  it("exposes the GitHub import + manual sync tools when the sync collaborator is composed", async () => {
    const client = await connect(makeDeps().deps);
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const name of [
      "list_github_import_candidates",
      "import_github_issues",
      "pull_github_issues",
      "sync_github_issue",
      "set_issue_github_sync",
      "get_github_issue_attachment",
    ]) {
      expect(names).toContain(name);
    }
  });

  it("an agent's issue transitions stamp causedBy so it never wakes on its own fact", async () => {
    const { deps, pushed } = makeDeps();
    const client = await connect(deps, { agentId: "triage-bot", conversationId: "conv-1" });
    const created = JSON.parse(
      textOf(
        await client.callTool({
          name: "create_issue",
          arguments: { title: "Retry drops tool results", status: "todo" },
        }),
      ),
    );
    expect(created.origin).toEqual({ agentId: "triage-bot", conversationId: "conv-1" });
    expect(pushed[0]).toMatchObject({ kind: "issue.created", causedBy: "agent:triage-bot:conv-1" });

    const resolved = JSON.parse(
      textOf(
        await client.callTool({
          name: "set_issue_status",
          arguments: { id: created.id, status: "done", resolution: { note: "verified" } },
        }),
      ),
    );
    expect(resolved.status).toBe("done");
    expect(pushed[1]).toMatchObject({
      kind: "issue.status_changed",
      causedBy: "agent:triage-bot:conv-1",
      payload: { from: "todo", to: "done", cause: "manual" },
    });
  });

  // The edit that puts work in an iteration — parity with PATCH /issues/:id, where the same field was missing
  // from the body schema. A tool that lists the field in its description but not its inputSchema is worse than
  // one that never offered it: the agent sends it and the SDK strips it.
  it("pulls an issue into its team's iteration through the ordinary edit", async () => {
    const client = await connect(makeDeps().deps);
    const issue = JSON.parse(
      textOf(await client.callTool({ name: "create_issue", arguments: { title: "Retry drops tool results" } })),
    );
    const cycle = JSON.parse(
      textOf(await client.callTool({ name: "create_cycle", arguments: { teamId: issue.teamId } })),
    );

    const moved = JSON.parse(
      textOf(await client.callTool({ name: "update_issue", arguments: { id: issue.id, cycleId: cycle.id } })),
    );
    expect(moved.cycleId).toBe(cycle.id);

    const cleared = JSON.parse(
      textOf(await client.callTool({ name: "update_issue", arguments: { id: issue.id, cycleId: null } })),
    );
    expect(cleared.cycleId).toBeUndefined();
  });

  it("reaches the same completion gate the HTTP surface does — a 409 arrives as a tool error", async () => {
    const client = await connect(makeDeps().deps);
    const initiative = JSON.parse(
      textOf(await client.callTool({ name: "create_initiative", arguments: { name: "agents people trust" } })),
    );
    const project = JSON.parse(
      textOf(
        await client.callTool({
          name: "create_project",
          arguments: { name: "quality", initiativeIds: [initiative.id] },
        }),
      ),
    );
    await client.callTool({
      name: "create_issue",
      arguments: { title: "still open", status: "todo", projectId: project.id },
    });
    const refused = await client.callTool({
      name: "set_initiative_status",
      arguments: { id: initiative.id, status: "completed" },
    });
    expect((refused as { isError?: boolean }).isError).toBe(true);
    expect(textOf(refused)).toContain("under this initiative are still open");

    // And the progress read names what is left rather than just refusing.
    const detail = JSON.parse(
      textOf(await client.callTool({ name: "get_initiative", arguments: { id: initiative.id } })),
    );
    expect(detail.readiness).toMatchObject({ ready: false, openIssues: 1 });
  });

  it("reports on a goal through the same update timeline the HTTP surface serves", async () => {
    const client = await connect(makeDeps().deps);
    const initiative = JSON.parse(
      textOf(await client.callTool({ name: "create_initiative", arguments: { name: "agents people trust" } })),
    );
    const posted = JSON.parse(
      textOf(
        await client.callTool({
          name: "post_initiative_update",
          arguments: { id: initiative.id, health: "off_track", body: "Two datasets are still unlabelled." },
        }),
      ),
    );
    expect(posted).toMatchObject({ initiativeId: initiative.id, health: "off_track" });
    // The goal carries the latest health, and the sentence stays readable on the timeline.
    const listed = JSON.parse(
      textOf(await client.callTool({ name: "list_initiative_updates", arguments: { id: initiative.id } })),
    );
    expect(listed).toHaveLength(1);
    expect(listed[0].body).toContain("unlabelled");
  });

  it("finds the issues watching a capability — the lookup before investigating a failing batch", async () => {
    const client = await connect(makeDeps().deps);
    const issue = JSON.parse(
      textOf(
        await client.callTool({
          name: "create_issue",
          arguments: { title: "flaky on retry", links: [{ type: "harness", id: "web-agent" }] },
        }),
      ),
    );
    const found = JSON.parse(
      textOf(await client.callTool({ name: "list_issues", arguments: { linkType: "harness", linkId: "web-agent" } })),
    );
    // Parity with the HTTP twin: one page of summaries, not a bare array of whole records.
    expect(found.items.map((i: { id: string }) => i.id)).toEqual([issue.id]);
  });
});
