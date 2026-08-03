import { IssueService, RunService, TeamService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import { InMemoryIssueStore, InMemoryRunStore, InMemoryTeamStore } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../server.js";

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused in tracker tests");
  },
};

const ADMIN = { "x-everdict-tenant": "acme" };

function build() {
  const teamStore = new InMemoryTeamStore();
  const issueStore = new InMemoryIssueStore();
  const teamService = new TeamService({ store: teamStore, issues: issueStore });
  const app = buildServer({
    service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    teamService,
    issueService: new IssueService({ teams: teamService, store: issueStore }),
  });
  return { app, teamService, issueStore };
}

describe("GET /teams", () => {
  it("repairs the invariant on read — a workspace that has never had a team gets its default", async () => {
    const { app } = build();
    const res = await app.inject({ method: "GET", url: "/teams", headers: ADMIN });
    expect(res.statusCode).toBe(200);
    const teams = res.json();
    expect(teams).toHaveLength(1);
    expect(teams[0].key).toBe("CORE");
    expect(teams[0].isDefault).toBe(true);
  });

  it("carries a derived summary per row", async () => {
    const { app } = build();
    await app.inject({ method: "POST", url: "/teams", headers: ADMIN, payload: { key: "ENG", name: "Eng" } });
    const res = await app.inject({ method: "GET", url: "/teams", headers: ADMIN });
    const eng = res.json().find((t: { key: string }) => t.key === "ENG");
    expect(eng.summary).toEqual({ memberCount: 1, openIssues: 0, totalIssues: 0 });
  });

  it("narrows to the caller's teams with mine=true", async () => {
    const { app, teamService } = build();
    await app.inject({ method: "POST", url: "/teams", headers: ADMIN, payload: { key: "ENG", name: "Eng" } });
    const ops = await teamService.create({ tenant: "acme", createdBy: "someone-else", key: "OPS", name: "Ops" });
    const res = await app.inject({ method: "GET", url: "/teams?mine=true", headers: ADMIN });
    expect(res.json().map((t: { id: string }) => t.id)).not.toContain(ops.id);
  });
});

describe("POST /teams", () => {
  it("creates a team and normalizes the key to uppercase", async () => {
    const { app } = build();
    const res = await app.inject({
      method: "POST",
      url: "/teams",
      headers: ADMIN,
      payload: { key: "eng", name: "Eng" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().key).toBe("ENG");
  });

  it("409s on a key the workspace already uses", async () => {
    const { app } = build();
    await app.inject({ method: "POST", url: "/teams", headers: ADMIN, payload: { key: "ENG", name: "Eng" } });
    const res = await app.inject({
      method: "POST",
      url: "/teams",
      headers: ADMIN,
      payload: { key: "ENG", name: "Other" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("400s on a key that is not 2-6 alphanumerics", async () => {
    const { app } = build();
    const res = await app.inject({ method: "POST", url: "/teams", headers: ADMIN, payload: { key: "E", name: "Eng" } });
    expect(res.statusCode).toBe(400);
  });
});

describe("team lifecycle", () => {
  it("hands the default flag over, leaving exactly one default", async () => {
    const { app } = build();
    await app.inject({ method: "GET", url: "/teams", headers: ADMIN }); // mint CORE
    const eng = (
      await app.inject({ method: "POST", url: "/teams", headers: ADMIN, payload: { key: "ENG", name: "Eng" } })
    ).json();
    const res = await app.inject({ method: "POST", url: `/teams/${eng.id}/default`, headers: ADMIN });
    expect(res.statusCode).toBe(200);
    const teams = await app.inject({ method: "GET", url: "/teams", headers: ADMIN });
    expect(teams.json().filter((t: { isDefault: boolean }) => t.isDefault)).toHaveLength(1);
  });

  it("409s when deleting the default team, and again when it is the last one", async () => {
    const { app } = build();
    const core = (await app.inject({ method: "GET", url: "/teams", headers: ADMIN })).json()[0];
    expect((await app.inject({ method: "DELETE", url: `/teams/${core.id}`, headers: ADMIN })).statusCode).toBe(409);
  });

  it("409s when deleting a team that still holds issues", async () => {
    const { app } = build();
    await app.inject({ method: "GET", url: "/teams", headers: ADMIN });
    const eng = (
      await app.inject({ method: "POST", url: "/teams", headers: ADMIN, payload: { key: "ENG", name: "Eng" } })
    ).json();
    await app.inject({ method: "POST", url: "/issues", headers: ADMIN, payload: { teamId: eng.id, title: "x" } });
    const res = await app.inject({ method: "DELETE", url: `/teams/${eng.id}`, headers: ADMIN });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/1 issue/);
  });

  it("404s for a team in another workspace instead of leaking its existence", async () => {
    const { app } = build();
    const eng = (
      await app.inject({ method: "POST", url: "/teams", headers: ADMIN, payload: { key: "ENG", name: "Eng" } })
    ).json();
    const res = await app.inject({
      method: "GET",
      url: `/teams/${eng.id}`,
      headers: { "x-everdict-tenant": "globex" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("issues are named by their team", () => {
  it("files into the default team when none is named, and stamps the identifier", async () => {
    const { app } = build();
    const res = await app.inject({
      method: "POST",
      url: "/issues",
      headers: ADMIN,
      payload: { title: "drops tool result" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().identifier).toBe("CORE-1");
    expect(res.json().number).toBe(1);
  });

  it("numbers each team independently", async () => {
    const { app } = build();
    await app.inject({ method: "GET", url: "/teams", headers: ADMIN });
    const eng = (
      await app.inject({ method: "POST", url: "/teams", headers: ADMIN, payload: { key: "ENG", name: "Eng" } })
    ).json();
    const first = await app.inject({ method: "POST", url: "/issues", headers: ADMIN, payload: { title: "a" } });
    const second = await app.inject({
      method: "POST",
      url: "/issues",
      headers: ADMIN,
      payload: { teamId: eng.id, title: "b" },
    });
    expect([first.json().identifier, second.json().identifier]).toEqual(["CORE-1", "ENG-1"]);
  });

  it("filters the issue list by team", async () => {
    const { app } = build();
    await app.inject({ method: "GET", url: "/teams", headers: ADMIN });
    const eng = (
      await app.inject({ method: "POST", url: "/teams", headers: ADMIN, payload: { key: "ENG", name: "Eng" } })
    ).json();
    await app.inject({ method: "POST", url: "/issues", headers: ADMIN, payload: { title: "core one" } });
    await app.inject({ method: "POST", url: "/issues", headers: ADMIN, payload: { teamId: eng.id, title: "eng one" } });
    const res = await app.inject({ method: "GET", url: `/issues?team=${eng.id}`, headers: ADMIN });
    expect(res.json().items).toHaveLength(1);
    expect(res.json().items[0].identifier).toBe("ENG-1");
  });
});

describe("team roster", () => {
  it("adds and removes members", async () => {
    const { app } = build();
    const eng = (
      await app.inject({ method: "POST", url: "/teams", headers: ADMIN, payload: { key: "ENG", name: "Eng" } })
    ).json();
    const added = await app.inject({
      method: "POST",
      url: `/teams/${eng.id}/members`,
      headers: ADMIN,
      payload: { subject: "alice" },
    });
    expect(added.statusCode).toBe(201);
    const members = await app.inject({ method: "GET", url: `/teams/${eng.id}/members`, headers: ADMIN });
    expect(members.json().map((m: { subject: string }) => m.subject)).toContain("alice");
    const removed = await app.inject({ method: "DELETE", url: `/teams/${eng.id}/members/alice`, headers: ADMIN });
    expect(removed.statusCode).toBe(204);
  });

  it("404s when removing someone who is not on the team", async () => {
    const { app } = build();
    const eng = (
      await app.inject({ method: "POST", url: "/teams", headers: ADMIN, payload: { key: "ENG", name: "Eng" } })
    ).json();
    const res = await app.inject({ method: "DELETE", url: `/teams/${eng.id}/members/nobody`, headers: ADMIN });
    expect(res.statusCode).toBe(404);
  });
});

// The team's key is its SLUG — the web addresses a team (and everything scoped to it) as `/{workspace}/teams/ENG/…`,
// so the control plane has to answer to the same name the URL carries. Same rule the issue identifier already has.
describe("a team is addressed by its key", () => {
  it("GETs by key, case-insensitively, and by id — one resource, two names", async () => {
    const { app } = build();
    const eng = (
      await app.inject({ method: "POST", url: "/teams", headers: ADMIN, payload: { key: "ENG", name: "Eng" } })
    ).json();
    for (const ref of ["ENG", "eng", eng.id]) {
      const res = await app.inject({ method: "GET", url: `/teams/${ref}`, headers: ADMIN });
      expect(res.statusCode).toBe(200);
      expect(res.json().id).toBe(eng.id);
    }
  });

  it("404s on a key nobody in this workspace holds", async () => {
    const { app } = build();
    expect((await app.inject({ method: "GET", url: "/teams/MOB", headers: ADMIN })).statusCode).toBe(404);
  });

  it("mutates through the key too — a slug that only reads is half a resource", async () => {
    const { app } = build();
    const eng = (
      await app.inject({ method: "POST", url: "/teams", headers: ADMIN, payload: { key: "ENG", name: "Eng" } })
    ).json();
    const renamed = await app.inject({
      method: "PATCH",
      url: "/teams/eng",
      headers: ADMIN,
      payload: { name: "Engineering" },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ id: eng.id, name: "Engineering" });
    const roster = await app.inject({
      method: "POST",
      url: "/teams/ENG/members",
      headers: ADMIN,
      payload: { subject: "alice" },
    });
    expect(roster.statusCode).toBe(201);
    expect(roster.json().teamId).toBe(eng.id);
  });

  it("scopes a list by key — the filter takes the same ref the URL does", async () => {
    const { app } = build();
    const eng = (
      await app.inject({ method: "POST", url: "/teams", headers: ADMIN, payload: { key: "ENG", name: "Eng" } })
    ).json();
    const mob = (
      await app.inject({ method: "POST", url: "/teams", headers: ADMIN, payload: { key: "MOB", name: "Mobile" } })
    ).json();
    await app.inject({ method: "POST", url: "/issues", headers: ADMIN, payload: { title: "flaky", teamId: eng.id } });
    await app.inject({
      method: "POST",
      url: "/issues",
      headers: ADMIN,
      payload: { title: "elsewhere", teamId: mob.id },
    });
    const scoped = await app.inject({ method: "GET", url: "/issues?team=ENG", headers: ADMIN });
    expect(scoped.statusCode).toBe(200);
    expect(scoped.json().items.map((i: { title: string }) => i.title)).toEqual(["flaky"]);
  });

  it("404s a list scoped to a team that does not exist, rather than answering with an empty one", async () => {
    // An empty list reads as "this team has nothing"; the honest answer to a bad slug is that there is no such team.
    const { app } = build();
    const res = await app.inject({ method: "GET", url: "/issues?team=NOPE", headers: ADMIN });
    expect(res.statusCode).toBe(404);
  });
});
