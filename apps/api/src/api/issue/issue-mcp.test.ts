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
      "accept_issue_triage",
      "decline_issue_triage",
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

  // ── THE TRIAGE LIFECYCLE, END TO END, ON THE TRANSPORT THAT WAS MISSING IT (arch-review 106) ─────
  //
  // Two findings meeting. `Issue.create`'s own comment names who enters the queue — "the surfaces that bring
  // work in from outside (import, an agent)" — and NOTHING in the repository wrote `inTriage: true`, so the
  // flag, both triage routes, both domain transitions, the store filter and the `?triage=` list param were a
  // designed lifecycle with no producer. Meanwhile both triage ROUTES read `agentAttributionFrom(req.headers)`
  // — built expecting an agent actor — while the transport an agent actually reaches the control plane
  // through exposed neither move, and this file's header calls itself "the surface an agent uses to triage".
  //
  // Nothing anywhere tested accept or decline, on any transport, which is how both halves stayed invisible.
  //
  // Seen RED before the doors existed: `create_issue` rejected `inTriage` ("Unrecognized key") and
  // `accept_issue_triage` did not exist ("Tool accept_issue_triage not found").
  it("an agent files into triage, and a member's accept takes it into the workflow", async () => {
    const { deps, pushed } = makeDeps();
    const client = await connect(deps, { agentId: "triage-bot", conversationId: "conv-9" });

    const filed = JSON.parse(
      textOf(
        await client.callTool({
          name: "create_issue",
          arguments: { title: "The retry loop drops tool results", inTriage: true },
        }),
      ),
    );
    expect(filed.inTriage, "an agent could not file into the queue the design says it files into").toBe(true);

    const accepted = JSON.parse(
      textOf(await client.callTool({ name: "accept_issue_triage", arguments: { id: filed.id, status: "todo" } })),
    );
    expect(accepted.inTriage, "accepting left the issue in the queue").toBe(false);
    expect(accepted.status).toBe("todo");
    // The transition rides the same choke point as every other one, so the agent's own fact is stamped and it
    // does not wake itself on it (loop guard #1).
    expect(pushed.at(-1)).toMatchObject({ kind: "issue.status_changed", causedBy: "agent:triage-bot:conv-9" });

    // Accepting is once: the queue is left, and leaving it again is a conflict rather than a silent no-op.
    const again = await client.callTool({ name: "accept_issue_triage", arguments: { id: filed.id } });
    expect(textOf(again)).toContain("not in triage");
  });

  // The accept tool declares `status: z.enum([...]).default("todo")`. Whether an MCP argument DEFAULT is
  // applied at all is a property of the transport's own parse, not of the schema literal — and if it were not,
  // `acceptTriage` would receive `undefined` where its parameter says `IssueStatus`, which is the silent
  // nullable default rule `typescript` forbids. Asserted rather than assumed.
  it("applies the accept tool's default landing status when the caller omits it", async () => {
    const { deps } = makeDeps();
    const client = await connect(deps, { agentId: "triage-bot", conversationId: "conv-9" });
    const filed = JSON.parse(
      textOf(await client.callTool({ name: "create_issue", arguments: { title: "Queued", inTriage: true } })),
    );
    const accepted = JSON.parse(
      textOf(await client.callTool({ name: "accept_issue_triage", arguments: { id: filed.id } })),
    );
    expect(accepted.status, "the omitted default never reached the service").toBe("todo");
    expect(accepted.inTriage).toBe(false);
  });

  it("declining cancels the issue and keeps it on the record, with the reason", async () => {
    const { deps } = makeDeps();
    const client = await connect(deps, { agentId: "triage-bot", conversationId: "conv-9" });
    const filed = JSON.parse(
      textOf(
        await client.callTool({
          name: "create_issue",
          arguments: { title: "Rewrite everything in Rust", inTriage: true },
        }),
      ),
    );

    const declined = JSON.parse(
      textOf(
        await client.callTool({
          name: "decline_issue_triage",
          arguments: { id: filed.id, note: "out of scope for this quarter" },
        }),
      ),
    );
    // "We said no to this" is an answer somebody looks for later — the issue survives its own decline.
    expect(declined.inTriage).toBe(false);
    const readBack = JSON.parse(textOf(await client.callTool({ name: "get_issue", arguments: { id: filed.id } })));
    expect(readBack.id, "the declined issue vanished from the record").toBe(filed.id);
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
