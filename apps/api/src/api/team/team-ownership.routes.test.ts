import { IssueService, RunService, TeamService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import { InMemoryIssueStore, InMemoryRunStore, InMemoryTeamStore } from "@everdict/db";
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

  it("lets ANY team read another team's asset — ownership filters lists, it does not hide the workspace", async () => {
    const ctx = await build();
    const owner = serverFor(ctx, ["member"], [ctx.web.id]);
    expect(
      (await owner.inject({ method: "POST", url: "/judges", headers: bearer, payload: judge("shared") })).statusCode,
    ).toBe(201);
    await owner.close();

    const other = serverFor(ctx, ["member"], [ctx.mobile.id], "other");
    const res = await other.inject({ method: "GET", url: "/judges", headers: bearer });
    expect(res.statusCode).toBe(200);
    expect(res.json().map((j: { id: string }) => j.id)).toContain("shared");
    await other.close();
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
