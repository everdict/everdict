import { IssueService, RunService, TeamService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import { InMemoryIssueStore, InMemoryRunStore, InMemoryTeamStore, InMemoryWorkspaceStore } from "@everdict/db";
import { InMemoryJudgeRegistry } from "@everdict/registry";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../server.js";

// The team axis, end to end over HTTP: a workspace member may write their own team's eval assets and not another
// team's. The kernel is unit-tested in @everdict/domain; what this locks is the WIRING — that the auth chain loads
// the caller's teams, that the route resolves the asset's owner, and that the two meet at gate().
const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused");
  },
};

async function build() {
  const teamStore = new InMemoryTeamStore();
  const issueStore = new InMemoryIssueStore();
  const teamService = new TeamService({ store: teamStore, issues: issueStore });
  const judgeRegistry = new InMemoryJudgeRegistry();
  // Two teams in one workspace — the whole point is that they are not each other's.
  const web = await teamService.create({ tenant: "acme", key: "WEB", name: "Web", createdBy: "system" });
  const mobile = await teamService.create({ tenant: "acme", key: "MOB", name: "Mobile", createdBy: "system" });
  return { teamStore, teamService, judgeRegistry, web, mobile, unusedDispatcher };
}

// A server whose authenticated principal is a fixed member of `teams` (authZ tests want a real authenticator —
// the dev-header fallback is admin, and admin deliberately bypasses the team check).
function serverFor(ctx: Awaited<ReturnType<typeof build>>, roles: string[], teams: string[], subject = "u") {
  return buildServer({
    service: new RunService({ dispatcher: ctx.unusedDispatcher, store: new InMemoryRunStore() }),
    teamService: ctx.teamService,
    judgeRegistry: ctx.judgeRegistry,
    requireAuth: true,
    authenticator: {
      async authenticate() {
        return { subject, workspace: "acme", roles, via: "oidc" as const, teams };
      },
    },
  });
}

// The same server, but with the principal's ROSTER left to the auth chain — the authenticator returns no
// `teams` at all, which is what a real authenticator does (OIDC and API keys carry a subject, not a roster).
// Every other case here injects `teams` directly, so none of them exercises `withTeams`: the union of the
// workspace's default team into the loaded roster could be deleted and the suite would stay green. A test
// that cannot fail for the reason it exists is not covering it, so this one drives the seam itself.
function serverForRealRoster(ctx: Awaited<ReturnType<typeof build>>, roles: string[], subject = "u") {
  return buildServer({
    service: new RunService({ dispatcher: ctx.unusedDispatcher, store: new InMemoryRunStore() }),
    teamService: ctx.teamService,
    judgeRegistry: ctx.judgeRegistry,
    // The roster is loaded during active-workspace resolution, which only runs with a membership store — so a
    // suite without one silently skips the very seam this case exists to cover.
    workspaceStore: new InMemoryWorkspaceStore(),
    requireAuth: true,
    authenticator: {
      async authenticate() {
        return { subject, workspace: "acme", roles, via: "oidc" as const };
      },
    },
  });
}

const bearer = { authorization: "Bearer t" };

function judge(id: string) {
  return { kind: "model", id, version: "1.0.0", model: "claude-opus-4-8", rubric: "Did it work?" };
}

describe("team ownership — an eval asset belongs to a team, and writes respect it", () => {
  it("stamps the creator's team on register, so the asset has an owner from the first version", async () => {
    // Given: a member of Web
    const ctx = await build();
    const app = serverFor(ctx, ["member"], [ctx.web.id]);
    // When
    const res = await app.inject({ method: "POST", url: "/judges", headers: bearer, payload: judge("quality") });
    // Then
    expect(res.statusCode).toBe(201);
    expect(await ctx.judgeRegistry.teamOfVersion?.("acme", "quality", "1.0.0")).toBe(ctx.web.id);
    await app.close();
  });

  it("refuses to register ON BEHALF OF a team the caller is not on", async () => {
    const ctx = await build();
    const app = serverFor(ctx, ["member"], [ctx.web.id]);
    const res = await app.inject({
      method: "POST",
      url: "/judges",
      headers: bearer,
      payload: { ...judge("smuggled"), teamId: ctx.mobile.id },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("falls back to the workspace's default team when the caller is on none — never leaves an asset unowned", async () => {
    const ctx = await build();
    const app = serverFor(ctx, ["member"], []);
    const res = await app.inject({ method: "POST", url: "/judges", headers: bearer, payload: judge("orphan") });
    expect(res.statusCode).toBe(201);
    // WEB is the workspace's first team, so it is the default.
    expect(await ctx.judgeRegistry.teamOfVersion?.("acme", "orphan", "1.0.0")).toBe(ctx.web.id);
    await app.close();
  });

  it("loads the roster from the control plane — a member on nobody's roster still reaches the default team", async () => {
    // Given: a member who was never written into any team's roster (which is every member of a workspace whose
    // admin has not got around to rostering anyone), naming the workspace's DEFAULT team explicitly — what the
    // registration form does when it preselects the owner.
    const ctx = await build();
    const app = serverForRealRoster(ctx, ["member"], "newcomer");
    const res = await app.inject({
      method: "POST",
      url: "/judges",
      headers: bearer,
      payload: { ...judge("house"), teamId: ctx.web.id }, // WEB is the workspace's default team
    });
    // Then: allowed. The default team is not a team someone chose to be on — it is where unowned work lands and
    // where the ownership migration put everything predating the axis, so a roster that omits it hides the
    // workspace's own assets from its own members. An explicit claim is gated, so this is the union being read.
    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it("keeps a rostered member's OWN teams as well — the default is a union, not a replacement", async () => {
    const ctx = await build();
    await ctx.teamService.addMember("acme", ctx.mobile.id, "mobiledev", { subject: "system" });
    const app = serverForRealRoster(ctx, ["member"], "mobiledev");
    const res = await app.inject({
      method: "POST",
      url: "/judges",
      headers: bearer,
      payload: { ...judge("mobile-quality"), teamId: ctx.mobile.id },
    });
    expect(res.statusCode).toBe(201); // an explicit claim on the team they are actually on
    expect(await ctx.judgeRegistry.teamOfVersion?.("acme", "mobile-quality", "1.0.0")).toBe(ctx.mobile.id);
    await app.close();
  });

  it("still SHOWS another team's asset — the roster says who may change a team's work, not who may see it", async () => {
    // The workspace is one workspace. Hiding every team's work behind its roster made a member of Web unable to
    // reuse the judge Mobile wrote, and made a goal's projects readable while the evaluations proving them were
    // "not found" on the same screen.
    const ctx = await build();
    const owner = serverFor(ctx, ["member"], [ctx.web.id]);
    expect(
      (await owner.inject({ method: "POST", url: "/judges", headers: bearer, payload: judge("theirs") })).statusCode,
    ).toBe(201);
    await owner.close();

    const other = serverFor(ctx, ["member"], [ctx.mobile.id], "other");
    expect((await other.inject({ method: "GET", url: "/judges", headers: bearer })).json()).toContainEqual(
      expect.objectContaining({ id: "theirs" }),
    );
    expect(
      (await other.inject({ method: "GET", url: "/judges/theirs/versions/1.0.0", headers: bearer })).statusCode,
    ).toBe(200);
    await other.close();
  });

  it("hides a PRIVATE team's asset — that is the one narrowing, and it answers 404 rather than 403", async () => {
    // Privacy is the team's own opt-in, and a refused read must not confirm the thing exists.
    const ctx = await build();
    const secret = await ctx.teamService.create({
      tenant: "acme",
      key: "SEC",
      name: "Secret",
      createdBy: "system",
      isPrivate: true,
    });
    // The roster is what privacy reads (`visibleTeamIds` asks the store, not the token), so the insider has to
    // actually be on it — which is also what `withTeams` would have loaded in production.
    await ctx.teamService.addMember("acme", secret.id, "u", { subject: "system" });
    const insider = serverFor(ctx, ["member"], [secret.id]);
    expect(
      (
        await insider.inject({
          method: "POST",
          url: "/judges",
          headers: bearer,
          payload: { ...judge("classified"), teamId: secret.id },
        })
      ).statusCode,
    ).toBe(201);
    expect((await insider.inject({ method: "GET", url: "/judges", headers: bearer })).json()).toContainEqual(
      expect.objectContaining({ id: "classified" }),
    );
    await insider.close();

    const outsider = serverFor(ctx, ["member"], [ctx.web.id], "other");
    expect((await outsider.inject({ method: "GET", url: "/judges", headers: bearer })).json()).not.toContainEqual(
      expect.objectContaining({ id: "classified" }),
    );
    expect(
      (await outsider.inject({ method: "GET", url: "/judges/classified/versions/1.0.0", headers: bearer })).statusCode,
    ).toBe(404);
    await outsider.close();

    // An admin governs every team — a private team they are not on would otherwise be un-administrable.
    const admin = serverFor(ctx, ["admin"], [], "boss");
    expect((await admin.inject({ method: "GET", url: "/judges", headers: bearer })).json()).toContainEqual(
      expect.objectContaining({ id: "classified" }),
    );
    await admin.close();
  });

  it("still shows an ADMIN every team's assets — an unreachable team would be un-administrable", async () => {
    const ctx = await build();
    const owner = serverFor(ctx, ["member"], [ctx.web.id]);
    await owner.inject({ method: "POST", url: "/judges", headers: bearer, payload: judge("theirs") });
    await owner.close();

    const admin = serverFor(ctx, ["admin"], [], "boss");
    const res = await admin.inject({ method: "GET", url: "/judges", headers: bearer });
    expect(res.json().map((j: { id: string }) => j.id)).toContain("theirs");
    expect((await admin.inject({ method: "GET", url: "/judges/theirs/versions/1.0.0", headers: bearer })).statusCode) //
      .toBe(200);
    await admin.close();
  });

  it("names the owning team by KEY too — the same ref the URL carries", async () => {
    const ctx = await build();
    const app = serverFor(ctx, ["member"], [ctx.web.id]);
    const res = await app.inject({
      method: "POST",
      url: "/judges",
      headers: bearer,
      payload: { ...judge("by-key"), teamId: "WEB" },
    });
    expect(res.statusCode).toBe(201);
    expect(await ctx.judgeRegistry.teamOfVersion?.("acme", "by-key", "1.0.0")).toBe(ctx.web.id);
    await app.close();
  });

  it("404s a team that does not exist rather than failing as a server error", async () => {
    // Resolving the ref moved in front of the gate, so an unknown team must come back as the store's 404 —
    // an unhandled throw here used to leave the route as a 500.
    const ctx = await build();
    const app = serverFor(ctx, ["admin"], [], "root");
    const res = await app.inject({
      method: "POST",
      url: "/judges",
      headers: bearer,
      payload: { ...judge("ghost"), teamId: "NOPE" },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("lets an admin write across teams — a team they are not on must not be un-administrable", async () => {
    const ctx = await build();
    const app = serverFor(ctx, ["admin"], [], "root");
    const res = await app.inject({
      method: "POST",
      url: "/judges",
      headers: bearer,
      payload: { ...judge("governed"), teamId: ctx.mobile.id },
    });
    expect(res.statusCode).toBe(201);
    expect(await ctx.judgeRegistry.teamOfVersion?.("acme", "governed", "1.0.0")).toBe(ctx.mobile.id);
    await app.close();
  });
});

describe("POST /issues/:id/team — an issue changes hands, and its address changes with it", () => {
  // A real TeamService here (not a stub allocator): the point of the move is that the destination team mints
  // the new number, so the test needs two teams with their own counters.
  async function server() {
    const ctx = await build();
    const issueStore = new InMemoryIssueStore();
    const app = buildServer({
      service: new RunService({ dispatcher: ctx.unusedDispatcher, store: new InMemoryRunStore() }),
      teamService: ctx.teamService,
      issueService: new IssueService({ teams: ctx.teamService, store: issueStore }),
    });
    return { app, ctx };
  }
  const H = { "x-everdict-tenant": "acme" };

  it("re-mints the identifier under the destination team and keeps the old one resolving", async () => {
    // Given: an issue filed on Web
    const { app, ctx } = await server();
    const filed = await app.inject({
      method: "POST",
      url: "/issues",
      headers: H,
      payload: { title: "flaky retry", teamId: ctx.web.id },
    });
    expect(filed.json().identifier).toBe("WEB-1");
    // When: it moves to Mobile
    const moved = await app.inject({
      method: "POST",
      url: `/issues/${filed.json().identifier}/team`,
      headers: H,
      payload: { teamId: ctx.mobile.id },
    });
    // Then: it answers to a Mobile name now …
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({ teamId: ctx.mobile.id, identifier: "MOB-1", formerIdentifiers: ["WEB-1"] });
    // … and the name in every link already pasted elsewhere still lands on it
    const byOldName = await app.inject({ method: "GET", url: "/issues/WEB-1", headers: H });
    expect(byOldName.json()).toMatchObject({ id: filed.json().id, identifier: "MOB-1" });
    await app.close();
  });

  it("409s on a move to the team the issue is already on", async () => {
    const { app, ctx } = await server();
    const filed = await app.inject({
      method: "POST",
      url: "/issues",
      headers: H,
      payload: { title: "flaky retry", teamId: ctx.web.id },
    });
    const res = await app.inject({
      method: "POST",
      url: `/issues/${filed.json().id}/team`,
      headers: H,
      payload: { teamId: ctx.web.id },
    });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it("403s for a viewer — moving an issue is a write", async () => {
    const ctx = await build();
    const app = buildServer({
      service: new RunService({ dispatcher: ctx.unusedDispatcher, store: new InMemoryRunStore() }),
      teamService: ctx.teamService,
      issueService: new IssueService({ teams: ctx.teamService, store: new InMemoryIssueStore() }),
      requireAuth: true,
      authenticator: {
        async authenticate() {
          return { subject: "v", workspace: "acme", roles: ["viewer"], via: "oidc" as const };
        },
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/issues/any/team",
      headers: bearer,
      payload: { teamId: ctx.mobile.id },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe("private teams — a visibility filter, and a 404 rather than a 403", () => {
  async function build() {
    const teamStore = new InMemoryTeamStore();
    const issueStore = new InMemoryIssueStore();
    const teamService = new TeamService({ store: teamStore, issues: issueStore });
    const open = await teamService.create({ tenant: "acme", key: "WEB", name: "Web", createdBy: "dana" });
    const secret = await teamService.create({
      tenant: "acme",
      key: "SEC",
      name: "Security",
      createdBy: "dana",
      isPrivate: true,
    });
    const issueService = new IssueService({ teams: teamService, store: issueStore });
    const hidden = await issueService.create({
      tenant: "acme",
      createdBy: "dana",
      teamId: secret.id,
      title: "an embargoed finding",
    });
    return { teamService, issueService, open, secret, hidden };
  }

  function serverFor(ctx: Awaited<ReturnType<typeof build>>, roles: string[], subject: string) {
    return buildServer({
      service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
      teamService: ctx.teamService,
      issueService: ctx.issueService,
      requireAuth: true,
      authenticator: {
        async authenticate() {
          return { subject, workspace: "acme", roles, via: "oidc" as const };
        },
      },
    });
  }

  it("drops a private team from the list, and its issues from the workspace list", async () => {
    // Given: erin is a member of the workspace but on no roster
    const ctx = await build();
    const app = serverFor(ctx, ["member"], "erin");
    const teams = (await app.inject({ method: "GET", url: "/teams", headers: bearer })).json();
    expect(teams.map((t: { key: string }) => t.key)).toEqual(["WEB"]);
    const issues = (await app.inject({ method: "GET", url: "/issues", headers: bearer })).json();
    expect(issues.items).toEqual([]);
    await app.close();
  });

  it("answers 404 — never 403 — for a private team's issue, so the error cannot confirm it exists", async () => {
    const ctx = await build();
    const app = serverFor(ctx, ["member"], "erin");
    const res = await app.inject({ method: "GET", url: `/issues/${ctx.hidden.id}`, headers: bearer });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("shows it to the roster, and to an admin who could join in one click anyway", async () => {
    const ctx = await build();
    // dana created the team, so dana is on its roster
    const asMember = serverFor(ctx, ["member"], "dana");
    expect(
      (await asMember.inject({ method: "GET", url: `/issues/${ctx.hidden.id}`, headers: bearer })).statusCode,
    ).toBe(200);
    await asMember.close();

    const asAdmin = serverFor(ctx, ["admin"], "erin");
    expect((await asAdmin.inject({ method: "GET", url: `/issues/${ctx.hidden.id}`, headers: bearer })).statusCode).toBe(
      200,
    );
    await asAdmin.close();
  });
});
