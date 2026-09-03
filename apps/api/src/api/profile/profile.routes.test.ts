import { ProfileService, RunService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import { InMemoryRunStore, InMemoryUserProfileStore, InMemoryWorkspaceStore } from "@everdict/db";
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
