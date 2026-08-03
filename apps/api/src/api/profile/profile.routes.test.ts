import { RunService, TeamService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import { InMemoryIssueStore, InMemoryRunStore, InMemoryTeamStore, InMemoryWorkspaceStore } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../server.js";

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused in profile tests");
  },
};
const svc = () => new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() });
const acme = { "x-everdict-tenant": "acme" };

// GET /me surfaces read-only instance config the web can't derive from the token — currently the community-instance
// public-publish policy. Off by default; reflects the operator's ServerDeps flag.
describe("GET /me — instance config", () => {
  it("reports allowMemberPublicPublish=false by default", async () => {
    const res = await buildServer({ service: svc() }).inject({ method: "GET", url: "/me", headers: acme });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ config: { allowMemberPublicPublish: false } });
  });

  it("reports allowMemberPublicPublish=true when the operator opts in", async () => {
    const res = await buildServer({ service: svc(), allowMemberPublicPublish: true }).inject({
      method: "GET",
      url: "/me",
      headers: acme,
    });
    expect(res.json()).toMatchObject({ config: { allowMemberPublicPublish: true } });
  });
});

// The web gates its team-scoped write buttons on the caller's TEAM memberships, and the only place it may learn
// them is here — decoding them from the token would make the browser the authority on its own permissions.
describe("GET /me — the caller's teams", () => {
  it("reports the teams the subject belongs to in the active workspace", async () => {
    const teamStore = new InMemoryTeamStore();
    const teamService = new TeamService({ store: teamStore, issues: new InMemoryIssueStore() });
    const eng = await teamService.create({ tenant: "acme", createdBy: "dana", key: "ENG", name: "Engineering" });
    await teamService.create({ tenant: "acme", createdBy: "someone-else", key: "MOB", name: "Mobile" });
    const app = buildServer({
      service: svc(),
      teamService,
      workspaceStore: new InMemoryWorkspaceStore(),
      requireAuth: true,
      authenticator: {
        async authenticate() {
          return { subject: "dana", workspace: "acme", roles: ["member"], via: "oidc" as const };
        },
      },
    });
    const res = await app.inject({ method: "GET", url: "/me", headers: { authorization: "Bearer t" } });
    expect(res.statusCode).toBe(200);
    // Only the ones whose roster holds them — a workspace member is not on every team.
    expect(res.json().teams).toEqual([eng.id]);
    await app.close();
  });
});
