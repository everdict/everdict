import { InitiativeService, IssueService, ProjectService, RunService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import {
  InMemoryInitiativeStore,
  InMemoryIssueStore,
  InMemoryProjectStore,
  InMemoryRunStore,
  InMemoryScorecardStore,
} from "@everdict/db";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../server.js";

// An issue is numbered by its owning team; these transport tests only need that to be deterministic.
const teamAllocator = (() => {
  let n = 0;
  return {
    async allocateForIssue() {
      n += 1;
      return { team: { id: "team-eng" }, grant: { number: n, identifier: `ENG-${n}` } };
    },
  };
})();

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
  const scorecardStore = new InMemoryScorecardStore();
  const app = buildServer({
    service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    issueService: new IssueService({ teams: teamAllocator, store: issueStore, scorecards: scorecardStore }),
    projectService: new ProjectService({ store: projectStore, issues: issueStore }),
    initiativeService: new InitiativeService({
      store: initiativeStore,
      projects: projectStore,
      issues: issueStore,
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
    expect(byLink.json()).toHaveLength(1);
    expect(
      (await app.inject({ method: "GET", url: "/issues?linkType=harness&linkId=other", headers: H })).json(),
    ).toHaveLength(0);

    const unlinked = await app.inject({
      method: "DELETE",
      url: `/issues/${issue.id}/links/harness/web-agent`,
      headers: H,
    });
    expect(unlinked.json().links).toEqual([]);
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
    expect((await app.inject({ method: "GET", url: "/issues", headers: other })).json()).toEqual([]);
    await app.close();
  });
});

describe("project + initiative routes — the release gate", () => {
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
      payload: { name: "conversation quality", initiativeId, targetDate: "2026-08-15" },
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

  it("a regressed issue inside a COMPLETED project still blocks the initiative", async () => {
    const { app } = build();
    const initiativeId = (
      await app.inject({ method: "POST", url: "/initiatives", headers: H, payload: { name: "v1" } })
    ).json().id;
    const projectId = (
      await app.inject({ method: "POST", url: "/projects", headers: H, payload: { name: "p", initiativeId } })
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
