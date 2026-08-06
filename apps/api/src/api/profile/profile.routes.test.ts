import { ProfileService, RunService, TeamService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import {
  InMemoryIssueStore,
  InMemoryRunStore,
  InMemoryTeamStore,
  InMemoryUserProfileStore,
  InMemoryWorkspaceStore,
} from "@everdict/db";
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

// The OIDC name claim seeds the user profile at login, so "who did this" surfaces (member lists, capability
// "created by") show a real name instead of the opaque sub — without the person ever visiting their account page.
describe("SSO name claim → user profile seed (login-time)", () => {
  const serverWithName = (profiles: InMemoryUserProfileStore, name?: string) =>
    buildServer({
      service: svc(),
      profileService: new ProfileService(profiles),
      workspaceStore: new InMemoryWorkspaceStore(),
      requireAuth: true,
      authenticator: {
        async authenticate() {
          return {
            subject: "u-1",
            workspace: "acme",
            roles: ["member"],
            via: "oidc" as const,
            ...(name !== undefined ? { name } : {}),
          };
        },
      },
    });

  it("a login carrying a name claim fills the empty profile", async () => {
    const profiles = new InMemoryUserProfileStore();
    const app = serverWithName(profiles, "Alice Kim");
    await app.inject({ method: "GET", url: "/me", headers: { authorization: "Bearer t" } });
    expect((await profiles.get("u-1"))?.name).toBe("Alice Kim");
    await app.close();
  });

  it("a name the person set themselves is never overwritten by the claim", async () => {
    const profiles = new InMemoryUserProfileStore();
    await profiles.upsert("u-1", { name: "앨리스" });
    const app = serverWithName(profiles, "Alice Kim");
    await app.inject({ method: "GET", url: "/me", headers: { authorization: "Bearer t" } });
    expect((await profiles.get("u-1"))?.name).toBe("앨리스");
    await app.close();
  });

  it("a login without a name claim leaves the profile untouched", async () => {
    const profiles = new InMemoryUserProfileStore();
    const app = serverWithName(profiles);
    await app.inject({ method: "GET", url: "/me", headers: { authorization: "Bearer t" } });
    expect(await profiles.get("u-1")).toBeUndefined();
    await app.close();
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

  it("puts every member on the DEFAULT team, rostered or not — nobody's screen is empty for want of an invite", async () => {
    // Ownership isolates reads, and the default team is where an unnamed asset lands and where everything that
    // predates the axis was migrated. Isolating THAT team would show a member who nobody has rostered yet an
    // empty workspace; the teams people actually created stay isolated, which is the point of the axis.
    const teamStore = new InMemoryTeamStore();
    const teamService = new TeamService({ store: teamStore, issues: new InMemoryIssueStore() });
    const core = await teamService.create({ tenant: "acme", createdBy: "dana", key: "CORE", name: "Core" });
    const mobile = await teamService.create({ tenant: "acme", createdBy: "dana", key: "MOB", name: "Mobile" });
    const app = buildServer({
      service: svc(),
      teamService,
      workspaceStore: new InMemoryWorkspaceStore(),
      requireAuth: true,
      authenticator: {
        async authenticate() {
          return { subject: "newcomer", workspace: "acme", roles: ["member"], via: "oidc" as const };
        },
      },
    });
    const res = await app.inject({ method: "GET", url: "/me", headers: { authorization: "Bearer t" } });
    expect(res.json().teams).toEqual([core.id]); // the default (first) team, and only it
    expect(res.json().teams).not.toContain(mobile.id);
    await app.close();
  });
});
