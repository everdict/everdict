import {
  InitiativeService,
  IssueService,
  ProjectService,
  RunService,
  TeamService,
} from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import {
  InMemoryInitiativeStore,
  InMemoryInitiativeUpdateStore,
  InMemoryIssueStore,
  InMemoryProjectStore,
  InMemoryRunStore,
  InMemoryScorecardStore,
  InMemoryTeamStore,
} from "@everdict/db";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../server.js";

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused in tracker tests");
  },
};

const H = { "x-everdict-tenant": "acme" };

function build() {
  const issueStore = new InMemoryIssueStore();
  const projectStore = new InMemoryProjectStore();
  const initiativeStore = new InMemoryInitiativeStore();
  const teamStore = new InMemoryTeamStore();
  const scorecardStore = new InMemoryScorecardStore();
  // The real team service, not a stand-in: an issue and a project have to land on the SAME default team, since
  // an issue may only join a project its own team is on. A fake allocator that answered with a team the project
  // store never heard of made that invariant untestable here — the wiring is production's.
  const teamService = new TeamService({ store: teamStore, issues: issueStore });
  const app = buildServer({
    service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    issueService: new IssueService({
      teams: teamService,
      store: issueStore,
      scorecards: scorecardStore,
      projects: projectStore,
    }),
    projectService: new ProjectService({
      store: projectStore,
      issues: issueStore,
      teams: teamStore,
      defaultTeam: teamService,
      initiatives: initiativeStore,
    }),
    initiativeService: new InitiativeService({
      store: initiativeStore,
      projects: projectStore,
      issues: issueStore,
      updates: new InMemoryInitiativeUpdateStore(),
    }),
  });
  return { app, issueStore, scorecardStore };
}

async function createIssue(app: ReturnType<typeof build>["app"], payload: Record<string, unknown>) {
  const res = await app.inject({ method: "POST", url: "/issues", headers: H, payload });
  expect(res.statusCode).toBe(201);
  return res.json();
}

describe("issue routes", () => {
  it("files an issue, links a capability, and lists it by the capability it watches", async () => {
    const { app } = build();
    const issue = await createIssue(app, { title: "Agent drops the tool result on retry", status: "todo" });
    expect(issue.status).toBe("todo");

    const linked = await app.inject({
      method: "POST",
      url: `/issues/${issue.id}/links`,
      headers: H,
      payload: { type: "harness", id: "web-agent", version: "2.1.0" },
    });
    expect(linked.statusCode).toBe(200);
    expect(linked.json().links).toHaveLength(1);

    // "Which issues watch this harness" — the reverse lookup a failing batch starts from.
    const byLink = await app.inject({
      method: "GET",
      url: "/issues?linkType=harness&linkId=web-agent",
      headers: H,
    });
    // The list serves a PAGE of summaries — `{ items, nextCursor? }` — so a row carries the link COUNT rather
    // than the links themselves; `GET /issues/:id` is where the link list lives.
    expect(byLink.json().items).toHaveLength(1);
    expect(byLink.json().items[0]).toMatchObject({ identifier: issue.identifier, linkCount: 1 });
    expect(byLink.json().items[0].description).toBeUndefined();
    expect(byLink.json().nextCursor).toBeUndefined(); // one page, nothing after it
    expect(
      (await app.inject({ method: "GET", url: "/issues?linkType=harness&linkId=other", headers: H })).json().items,
    ).toHaveLength(0);

    const unlinked = await app.inject({
      method: "DELETE",
      url: `/issues/${issue.id}/links/harness/web-agent`,
      headers: H,
    });
    expect(unlinked.json().links).toEqual([]);
    await app.close();
  });

  // An issue picker (the capability detail's "link an issue", one issue mentioning another) types a NAME, not
  // an id. Searching in the control plane is what keeps it finding issues once the workspace outgrows a page.
  it("searches issues by identifier or title, and mentions one issue from another", async () => {
    const { app } = build();
    const target = await createIssue(app, { title: "Judge reads a stale rubric", status: "todo" });
    const other = await createIssue(app, { title: "Agent drops the tool result on retry", status: "todo" });

    const byTitle = await app.inject({ method: "GET", url: "/issues?q=stale%20rubric", headers: H });
    expect(byTitle.json().items.map((i: { id: string }) => i.id)).toEqual([target.id]);
    const byIdentifier = await app.inject({
      method: "GET",
      url: `/issues?q=${target.identifier.toLowerCase()}`,
      headers: H,
    });
    expect(byIdentifier.json().items.map((i: { id: string }) => i.id)).toEqual([target.id]);
    expect((await app.inject({ method: "GET", url: "/issues?q=nothing-matches", headers: H })).json().items).toEqual(
      [],
    );

    // One issue mentions another — stored on the MENTIONING issue, read back from the mentioned one with the
    // same reverse query a harness uses.
    const mentioned = await app.inject({
      method: "POST",
      url: `/issues/${other.id}/links`,
      headers: H,
      payload: { type: "issue", id: target.id },
    });
    expect(mentioned.statusCode).toBe(200);
    const backlinks = await app.inject({
      method: "GET",
      url: `/issues?linkType=issue&linkId=${target.id}`,
      headers: H,
    });
    expect(backlinks.json().items.map((i: { id: string }) => i.id)).toEqual([other.id]);
    await app.close();
  });

  // The web addresses an issue by the name its team minted — `/{workspace}/issues/ENG-12` — so the same ref has
  // to reach the control plane's reads AND mutations, or a link people paste only half works.
  it("addresses an issue by its identifier as well as its id, on reads and mutations alike", async () => {
    const { app } = build();
    const issue = await createIssue(app, { title: "t", status: "todo" });

    const bySlug = await app.inject({ method: "GET", url: `/issues/${issue.identifier}`, headers: H });
    expect(bySlug.statusCode).toBe(200);
    expect(bySlug.json().id).toBe(issue.id);

    const lowercased = await app.inject({
      method: "GET",
      url: `/issues/${issue.identifier.toLowerCase()}`,
      headers: H,
    });
    expect(lowercased.json().id).toBe(issue.id);

    const evaluation = await app.inject({ method: "GET", url: `/issues/${issue.identifier}/scorecards`, headers: H });
    expect(evaluation.statusCode).toBe(200);

    const moved = await app.inject({
      method: "POST",
      url: `/issues/${issue.identifier}/status`,
      headers: H,
      payload: { status: "in_progress" },
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().id).toBe(issue.id);
    expect(moved.json().status).toBe("in_progress");

    // An identifier nobody minted is a 404, exactly like an unknown id.
    expect((await app.inject({ method: "GET", url: "/issues/ENG-9999", headers: H })).statusCode).toBe(404);
    await app.close();
  });

  it("moves an issue through resolve → regressed, keeping the resolution as the regression baseline", async () => {
    const { app } = build();
    const issue = await createIssue(app, { title: "t", status: "in_progress" });

    const resolved = await app.inject({
      method: "POST",
      url: `/issues/${issue.id}/status`,
      headers: H,
      payload: { status: "done", resolution: { note: "green on the regression suite" } },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().resolution).toMatchObject({ note: "green on the regression suite" });

    const regressed = await app.inject({
      method: "POST",
      url: `/issues/${issue.id}/status`,
      headers: H,
      payload: { status: "regressed" },
    });
    expect(regressed.statusCode).toBe(200);
    expect(regressed.json().status).toBe("regressed");
    expect(regressed.json().resolution).toMatchObject({ note: "green on the regression suite" });
    // The durable history records the whole arc — the event log is swept, this is not.
    expect(regressed.json().history.map((h: { event: string }) => h.event)).toEqual([
      "created",
      "resolved",
      "reopened",
    ]);
    await app.close();
  });

  it("refuses an illegal move with the domain's 409 and an unknown resolution scorecard with 400", async () => {
    const { app } = build();
    const issue = await createIssue(app, { title: "t", status: "todo" });
    expect(
      (await app.inject({ method: "POST", url: `/issues/${issue.id}/status`, headers: H, payload: { status: "todo" } }))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/issues/${issue.id}/status`,
          headers: H,
          payload: { status: "done", resolution: { scorecardId: "sc-missing" } },
        })
      ).statusCode,
    ).toBe(400);
    await app.close();
  });

  it("edits content through PATCH and refuses a status change smuggled into it", async () => {
    const { app } = build();
    const issue = await createIssue(app, { title: "t" });
    const patched = await app.inject({
      method: "PATCH",
      url: `/issues/${issue.id}`,
      headers: H,
      payload: { title: "Retry drops tool results", assignee: "dana" },
    });
    expect(patched.json().title).toBe("Retry drops tool results");
    expect(patched.json().status).toBe("backlog"); // untouched
    // Clearing is explicit
    const cleared = await app.inject({
      method: "PATCH",
      url: `/issues/${issue.id}`,
      headers: H,
      payload: { assignee: null },
    });
    expect(cleared.json().assignee).toBeUndefined();
    expect(
      (await app.inject({ method: "PATCH", url: `/issues/${issue.id}`, headers: H, payload: {} })).statusCode,
    ).toBe(400);
    await app.close();
  });

  it("validates the body, scopes unknown ids to 404, and 404s without a composed service", async () => {
    const { app } = build();
    expect((await app.inject({ method: "POST", url: "/issues", headers: H, payload: { title: "" } })).statusCode).toBe(
      400,
    );
    expect((await app.inject({ method: "GET", url: "/issues/missing", headers: H })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/issues?linkType=harness", headers: H })).statusCode).toBe(400); // linkType without linkId

    const bare = buildServer({
      service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    });
    expect((await bare.inject({ method: "GET", url: "/issues", headers: H })).statusCode).toBe(404);
    await bare.close();
    await app.close();
  });

  it("scopes every read to the workspace — another workspace's issue is a 404, not a 403", async () => {
    const { app } = build();
    const issue = await createIssue(app, { title: "t" });
    const other = { "x-everdict-tenant": "globex" };
    expect((await app.inject({ method: "GET", url: `/issues/${issue.id}`, headers: other })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/issues", headers: other })).json()).toEqual({ items: [] });
    await app.close();
  });

  // The list is a PAGE, and it has to stay one across the whole set: an issue must appear on exactly one page,
  // and the walk must terminate. Both are properties of the cursor, so the test walks the pages rather than
  // asserting the shape of a single one.
  it("serves the list one page at a time — every issue exactly once, then no cursor", async () => {
    const { app } = build();
    for (let n = 0; n < 5; n += 1) await createIssue(app, { title: `issue ${n}` });

    const seen: string[] = [];
    let url = "/issues?limit=2";
    let pages = 0;
    for (;;) {
      const body = (await app.inject({ method: "GET", url, headers: H })).json();
      seen.push(...body.items.map((row: { identifier: string }) => row.identifier));
      pages += 1;
      if (!body.nextCursor) break;
      url = `/issues?limit=2&cursor=${encodeURIComponent(body.nextCursor)}`;
    }
    expect(pages).toBe(3); // 2 + 2 + 1
    expect(new Set(seen).size).toBe(5);
    await app.close();
  });

  it("narrows to the GitHub bulk sync's working set server-side, instead of making the caller read everything", async () => {
    const { app, issueStore } = build();
    const github = {
      repository: "acme/agent",
      number: 1,
      url: "https://github.com/acme/agent/issues/1",
      state: "open" as const,
      comments: [],
    };
    const pulling = await createIssue(app, { title: "pulled" });
    const notPulling = await createIssue(app, { title: "local only" });
    await issueStore.update("acme", pulling.id, { github: { ...github, sync: { pull: true, push: false } } });
    await issueStore.update("acme", notPulling.id, {
      github: { ...github, number: 2, sync: { pull: false, push: false } },
    });

    const page = (await app.inject({ method: "GET", url: "/issues?syncPull=true", headers: H })).json();
    expect(page.items.map((row: { id: string }) => row.id)).toEqual([pulling.id]);
    // The row keeps exactly what a repository roster needs, and not the comment slice the record carries.
    expect(page.items[0].github).toEqual({ repository: "acme/agent", pull: true });
    await app.close();
  });
});

describe("project + initiative routes — the completion gate", () => {
  it("rolls issues up to a project and refuses completing an initiative while work is open", async () => {
    const { app } = build();
    const initiative = await app.inject({
      method: "POST",
      url: "/initiatives",
      headers: H,
      payload: { name: "v1 agent deploy", targetDate: "2026-08-31" },
    });
    expect(initiative.statusCode).toBe(201);
    const initiativeId = initiative.json().id;

    const project = await app.inject({
      method: "POST",
      url: "/projects",
      headers: H,
      payload: { name: "conversation quality", initiativeIds: [initiativeId], targetDate: "2026-08-15" },
    });
    expect(project.statusCode).toBe(201);
    const projectId = project.json().id;

    const open = await createIssue(app, { title: "still failing", status: "in_progress", projectId });
    const closed = await createIssue(app, { title: "fixed", status: "in_progress", projectId });
    await app.inject({
      method: "POST",
      url: `/issues/${closed.id}/status`,
      headers: H,
      payload: { status: "done", resolution: { note: "verified" } },
    });

    // The project detail carries the rollup; the list stays lean.
    const detail = await app.inject({ method: "GET", url: `/projects/${projectId}`, headers: H });
    expect(detail.json().rollup).toMatchObject({ total: 2, open: 1, done: 1, ready: false });

    // The gate refuses, and names what is left.
    const refused = await app.inject({
      method: "POST",
      url: `/initiatives/${initiativeId}/status`,
      headers: H,
      payload: { status: "completed" },
    });
    expect(refused.statusCode).toBe(409);

    const readiness = (await app.inject({ method: "GET", url: `/initiatives/${initiativeId}`, headers: H })).json()
      .readiness;
    expect(readiness).toMatchObject({ ready: false, openIssues: 1, totalIssues: 2 });
    expect(readiness.blockers.map((b: { issueId: string }) => b.issueId)).toEqual([open.id]);

    // Resolve the last issue and the gate opens.
    await app.inject({
      method: "POST",
      url: `/issues/${open.id}/status`,
      headers: H,
      payload: { status: "done", resolution: { note: "verified too" } },
    });
    const completed = await app.inject({
      method: "POST",
      url: `/initiatives/${initiativeId}/status`,
      headers: H,
      payload: { status: "completed" },
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().status).toBe("completed");
    await app.close();
  });

  it("a goal starts planned and carries its face, its people and where it is written down", async () => {
    const { app } = build();
    const created = await app.inject({
      method: "POST",
      url: "/initiatives",
      headers: H,
      payload: {
        name: "agents people trust",
        icon: "🎯",
        lead: "dana",
        memberIds: ["dana", "erin"],
        resources: [{ label: "design doc", url: "https://example.com/doc" }],
      },
    });
    expect(created.statusCode).toBe(201);
    // Planned, not active: what the goal means is still being decided, and calling that active made every
    // idea look like work in flight.
    expect(created.json()).toMatchObject({
      status: "planned",
      icon: "🎯",
      memberIds: ["dana", "erin"],
      resources: [{ label: "design doc", url: "https://example.com/doc" }],
    });

    // A resource without a real URL is not a link.
    const bad = await app.inject({
      method: "PATCH",
      url: `/initiatives/${created.json().id}`,
      headers: H,
      payload: { resources: [{ label: "broken", url: "not-a-url" }] },
    });
    expect(bad.statusCode).toBe(400);

    const moved = await app.inject({
      method: "POST",
      url: `/initiatives/${created.json().id}/status`,
      headers: H,
      payload: { status: "active" },
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().status).toBe("active");
    await app.close();
  });

  it("the initiative LIST carries each goal's progress, so a row answers 'how far along' without a second read", async () => {
    const { app } = build();
    const initiativeId = (
      await app.inject({
        method: "POST",
        url: "/initiatives",
        headers: H,
        payload: { name: "agents people trust" },
      })
    ).json().id;
    const projectId = (
      await app.inject({
        method: "POST",
        url: "/projects",
        headers: H,
        payload: { name: "conversation quality", initiativeIds: [initiativeId] },
      })
    ).json().id;
    const open = await createIssue(app, { title: "still failing", status: "in_progress", projectId });
    const closed = await createIssue(app, { title: "fixed", status: "in_progress", projectId });
    await app.inject({
      method: "POST",
      url: `/issues/${closed.id}/status`,
      headers: H,
      payload: { status: "done", resolution: { note: "verified" } },
    });

    const listed = (await app.inject({ method: "GET", url: "/initiatives", headers: H })).json();
    expect(listed[0]).toMatchObject({ id: initiativeId, progress: { open: 1, total: 2, projects: 1 } });

    // And the row agrees with the page it links to.
    const detail = (await app.inject({ method: "GET", url: `/initiatives/${initiativeId}`, headers: H })).json();
    expect(detail.readiness).toMatchObject({ openIssues: 1, totalIssues: 2 });
    expect(detail.readiness.blockers.map((b: { issueId: string }) => b.issueId)).toEqual([open.id]);
    await app.close();
  });

  it("posts an update on the goal — the health lands on the record and the sentence stays the timeline", async () => {
    const { app } = build();
    const initiativeId = (
      await app.inject({
        method: "POST",
        url: "/initiatives",
        headers: H,
        payload: { name: "agents people trust", lead: "dana" },
      })
    ).json().id;

    const posted = await app.inject({
      method: "POST",
      url: `/initiatives/${initiativeId}/updates`,
      headers: H,
      payload: { health: "at_risk", body: "The judge rewrite slipped a week." },
    });
    expect(posted.statusCode).toBe(201);
    expect(posted.json()).toMatchObject({ initiativeId, health: "at_risk" });

    // A health flag with no sentence is not an update — the body is required.
    const empty = await app.inject({
      method: "POST",
      url: `/initiatives/${initiativeId}/updates`,
      headers: H,
      payload: { health: "off_track" },
    });
    expect(empty.statusCode).toBe(400);

    // The record carries the LATEST health so a row draws it without reading the timeline; the lead rides along.
    const detail = (await app.inject({ method: "GET", url: `/initiatives/${initiativeId}`, headers: H })).json();
    expect(detail).toMatchObject({ health: "at_risk", lead: "dana" });

    const timeline = await app.inject({ method: "GET", url: `/initiatives/${initiativeId}/updates`, headers: H });
    expect(timeline.statusCode).toBe(200);
    expect(timeline.json()).toHaveLength(1);
    await app.close();
  });

  it("a regressed issue inside a COMPLETED project still blocks the initiative", async () => {
    const { app } = build();
    const initiativeId = (
      await app.inject({ method: "POST", url: "/initiatives", headers: H, payload: { name: "v1" } })
    ).json().id;
    const projectId = (
      await app.inject({
        method: "POST",
        url: "/projects",
        headers: H,
        payload: { name: "p", initiativeIds: [initiativeId] },
      })
    ).json().id;
    const issue = await createIssue(app, { title: "fixed then broke", status: "in_progress", projectId });
    await app.inject({
      method: "POST",
      url: `/issues/${issue.id}/status`,
      headers: H,
      payload: { status: "done", resolution: { note: "verified" } },
    });
    await app.inject({
      method: "POST",
      url: `/projects/${projectId}/status`,
      headers: H,
      payload: { status: "completed" },
    });
    await app.inject({
      method: "POST",
      url: `/issues/${issue.id}/status`,
      headers: H,
      payload: { status: "regressed" },
    });

    const refused = await app.inject({
      method: "POST",
      url: `/initiatives/${initiativeId}/status`,
      headers: H,
      payload: { status: "completed" },
    });
    expect(refused.statusCode).toBe(409);

    // Forcing is the explicit, recorded override.
    const forced = await app.inject({
      method: "POST",
      url: `/initiatives/${initiativeId}/status`,
      headers: H,
      payload: { status: "completed", force: true },
    });
    expect(forced.statusCode).toBe(200);
    await app.close();
  });

  it("refuses deleting a project that still holds issues", async () => {
    const { app } = build();
    const projectId = (
      await app.inject({ method: "POST", url: "/projects", headers: H, payload: { name: "p" } })
    ).json().id;
    await createIssue(app, { title: "t", projectId });
    expect((await app.inject({ method: "DELETE", url: `/projects/${projectId}`, headers: H })).statusCode).toBe(409);
    await app.close();
  });
});

describe("issue list — the grouped screen's query", () => {
  it("takes a SET per facet, ANDs across facets, and reaches the unassigned bucket with an empty value", async () => {
    const { app } = build();
    await createIssue(app, { title: "one", status: "todo", assignee: "dana", labelIds: ["bug"] });
    await createIssue(app, { title: "two", status: "in_progress", labelIds: ["bug", "flaky"] });
    await createIssue(app, { title: "three", status: "cancelled", assignee: "sam", labelIds: ["flaky"] });

    const titles = async (query: string) =>
      (await app.inject({ method: "GET", url: `/issues?${query}`, headers: H }))
        .json()
        .items.map((i: { title: string }) => i.title)
        .sort();

    // Repeating the key is how a query string spells a set — "still in flight" is three statuses, not three calls.
    expect(await titles("status=todo&status=in_progress")).toEqual(["one", "two"]);
    // Labels intersect: carrying any one of them matches.
    expect(await titles("label=flaky")).toEqual(["three", "two"]);
    // An empty value is the unset bucket — a real group members filter to.
    expect(await titles("assignee=")).toEqual(["two"]);
    expect(await titles("assignee=dana&assignee=")).toEqual(["one", "two"]);
    expect(await titles("status=todo&status=cancelled&label=flaky")).toEqual(["three"]);
    await app.close();
  });

  it("orders by priority and refuses a cursor minted under a different ordering", async () => {
    const { app } = build();
    await createIssue(app, { title: "low", priority: "low" });
    await createIssue(app, { title: "urgent", priority: "urgent" });
    await createIssue(app, { title: "none" });

    const byPriority = await app.inject({ method: "GET", url: "/issues?order=priority&limit=2", headers: H });
    expect(byPriority.json().items.map((i: { title: string }) => i.title)).toEqual(["urgent", "low"]);
    const cursor = byPriority.json().nextCursor;
    expect(cursor).toBeTruthy();

    // Same token, different ordering: a position in one sequence means nothing in another, so it is refused
    // rather than served as a window that silently skips or repeats rows.
    const crossed = await app.inject({
      method: "GET",
      url: `/issues?order=created&cursor=${encodeURIComponent(cursor)}`,
      headers: H,
    });
    expect(crossed.statusCode).toBe(400);
    expect(crossed.json().code).toBe("BAD_REQUEST");
    await app.close();
  });

  it("counts each group under the same filter the rows are drawn with", async () => {
    const { app } = build();
    await createIssue(app, { title: "one", status: "todo", assignee: "dana" });
    await createIssue(app, { title: "two", status: "todo", assignee: "dana" });
    await createIssue(app, { title: "three", status: "todo" });
    await createIssue(app, { title: "four", status: "cancelled", assignee: "sam" });

    const all = await app.inject({ method: "GET", url: "/issues/counts?groupBy=status", headers: H });
    expect(all.statusCode).toBe(200);
    expect(all.json()).toEqual({
      groupBy: "status",
      groups: [
        { key: "todo", count: 3 },
        { key: "cancelled", count: 1 },
      ],
      total: 4,
    });

    // The unset bucket is a group with a null key, and it sorts last whatever its size.
    const byAssignee = await app.inject({
      method: "GET",
      url: "/issues/counts?groupBy=assignee&status=todo",
      headers: H,
    });
    expect(byAssignee.json().groups).toEqual([
      { key: "dana", count: 2 },
      { key: null, count: 1 },
    ]);
    expect(byAssignee.json().total).toBe(3);

    // `counts` is a static segment — it must never be read as an issue id by the `/issues/:id` route.
    expect((await app.inject({ method: "GET", url: "/issues/counts?groupBy=nonsense", headers: H })).statusCode).toBe(
      400,
    );
    await app.close();
  });

  // The scope helper's three team reads (my teams · the teams I may see · the team the URL names) now go out
  // TOGETHER instead of one after another — they decide nothing about each other, and this helper runs in front
  // of EVERY list query, once per group on a grouped screen. Overlapping them puts an unknown team's rejection
  // inside a `Promise.all`, where the naive spelling loses it: a sibling that settles first would let the whole
  // block reject with something else, or the rejection would surface as a 500 rather than the 404 the URL earned.
  // A team that does not exist must still read as ABSENT, on the rows and on the counts alike.
  it("still 404s an unknown team ref on both list endpoints, now that the scope reads overlap", async () => {
    // This one composes the team service on the SERVER (the shared fixture leaves it out, and without it
    // `resolveTeamRef` keeps a ref verbatim by design — there is nothing to resolve against). The 404 being
    // tested is the team service's answer, so it only exists in a deployment that has one.
    const issueStore = new InMemoryIssueStore();
    const teamStore = new InMemoryTeamStore();
    const teamService = new TeamService({ store: teamStore, issues: issueStore });
    const app = buildServer({
      service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
      issueService: new IssueService({ teams: teamService, store: issueStore }),
      teamService,
    });
    await createIssue(app, { title: "one", status: "todo" });

    for (const url of ["/issues?team=NOPE", "/issues/counts?groupBy=status&team=NOPE"]) {
      const res = await app.inject({ method: "GET", url, headers: H });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe("NOT_FOUND");
    }

    // And the happy path still narrows rather than 404-ing: the default team the issue was filed into is
    // nameable by its KEY, which is what the team-scoped URL actually sends.
    const teams = await app.inject({ method: "GET", url: "/teams", headers: H });
    const key = teams.json()[0].key;
    const scoped = await app.inject({ method: "GET", url: `/issues?team=${key}`, headers: H });
    expect(scoped.statusCode).toBe(200);
    expect(scoped.json().items.map((i: { title: string }) => i.title)).toEqual(["one"]);
    await app.close();
  });
});
