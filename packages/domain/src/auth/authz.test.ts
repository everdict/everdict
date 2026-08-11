import { describe, expect, it } from "vitest";
import { authorize, can, ownedByAnyVisibleTeam, ownedByVisibleTeam } from "./authz.js";
import type { Principal } from "./principal.js";

describe("can — the team axis (team-owned resources)", () => {
  const member: Principal = { subject: "u", workspace: "acme", roles: ["member"], via: "oidc", teams: ["web"] };
  const admin: Principal = { subject: "a", workspace: "acme", roles: ["admin"], via: "oidc", teams: [] };
  const teamless: Principal = { subject: "t", workspace: "acme", roles: ["member"], via: "oidc" };

  it("lets a member write a resource owned by a team they are on", () => {
    expect(can(member, "harnesses:register", { teamId: "web" })).toBe(true);
  });

  it("refuses a write against a team they are not on", () => {
    expect(can(member, "harnesses:register", { teamId: "mobile" })).toBe(false);
  });

  it("READS another team's resource — the roster says who may CHANGE a team's work, not who may see it", () => {
    // A workspace whose teams cannot see each other's work has stopped being one workspace. What hides a team's
    // work is that team choosing to be PRIVATE, which is a property of the team and therefore not this kernel's
    // to answer (TeamService.visibleTeamIds decides it, and a refusal is answered 404).
    expect(can(member, "harnesses:read", { teamId: "mobile" })).toBe(true);
    expect(can(member, "scorecards:read", { teamId: "mobile" })).toBe(true);
    expect(can(member, "harnesses:register", { teamId: "mobile" })).toBe(false); // ...writing still is
  });

  it("keeps a machine credential outside the team axis — a runner/CI token has no roster to be isolated by", () => {
    const ci: Principal = { subject: "repo:acme/api", workspace: "acme", roles: ["ci"], via: "github-actions" };
    expect(can(ci, "scorecards:run", { teamId: "mobile" })).toBe(true);
    // An agent credential is NOT exempt: it acts as its creator, so it writes with that person's teams.
    const agent: Principal = { subject: "u", workspace: "acme", roles: ["member"], via: "agent", teams: ["web"] };
    expect(can(agent, "scorecards:run", { teamId: "mobile" })).toBe(false);
    expect(can(agent, "scorecards:run", { teamId: "web" })).toBe(true);
  });

  it("narrows a list row by the VISIBLE-team ceiling — undefined means nothing is hidden, never 'nothing'", () => {
    expect(ownedByVisibleTeam({ teamId: "mobile" }, undefined)).toBe(true); // no private team anywhere
    expect(ownedByVisibleTeam({ teamId: "mobile" }, ["web"])).toBe(false); // mobile is private, not mine
    expect(ownedByVisibleTeam({ teamId: "web" }, ["web"])).toBe(true);
    expect(ownedByVisibleTeam({}, ["web"])).toBe(true); // unowned = the workspace's
  });

  it("shows a row that names SEVERAL teams when ANY of them is visible — a project is worked on by all of them", () => {
    expect(ownedByAnyVisibleTeam({ teamIds: ["mobile", "web"] }, ["web"])).toBe(true);
    expect(ownedByAnyVisibleTeam({ teamIds: ["mobile"] }, ["web"])).toBe(false);
    expect(ownedByAnyVisibleTeam({ teamIds: [] }, ["web"])).toBe(true); // names none = the workspace's
    expect(ownedByAnyVisibleTeam({ teamIds: ["mobile"] }, undefined)).toBe(true);
  });

  it("lets an admin write any team's resource — an unreachable team would be un-administrable", () => {
    expect(can(admin, "harnesses:register", { teamId: "mobile" })).toBe(true);
  });

  it("leaves an unowned resource alone — 'no owner' must never read as 'everyone's team'", () => {
    expect(can(member, "harnesses:register", {})).toBe(true);
    expect(can(member, "harnesses:register")).toBe(true);
  });

  it("refuses a subject on no team at all against an owned resource", () => {
    expect(can(teamless, "harnesses:register", { teamId: "web" })).toBe(false);
  });

  it("does not let the team axis widen a role that never had the action", () => {
    // `harnesses:register` is deliberately viewer+ ("collaborative eval content"), so use one that is not:
    // being on the team must not hand a viewer an action the role matrix withholds.
    const viewer: Principal = { subject: "v", workspace: "acme", roles: ["viewer"], via: "oidc", teams: ["web"] };
    expect(can(viewer, "datasets:write", { teamId: "web" })).toBe(false);
  });

  it("keeps the api-key scope intersection — being on the team cannot restore a scope the key lacks", () => {
    const scoped: Principal = {
      subject: "k",
      workspace: "acme",
      roles: ["member"],
      via: "api-key",
      scopes: ["read"],
      teams: ["web"],
    };
    expect(can(scoped, "harnesses:register", { teamId: "web" })).toBe(false);
  });

  it("names the team in the 403 so the fix is obvious", () => {
    expect(() => authorize(member, "harnesses:register", { teamId: "mobile" })).toThrow(/team you are not on/);
  });
});

describe("teams:join — self-service membership is member-level, roster governance stays admin", () => {
  it("a member may join, a viewer may not, and teams:write stays out of member's reach", () => {
    const member: Principal = { subject: "u", workspace: "acme", roles: ["member"], via: "oidc" };
    const viewer: Principal = { subject: "v", workspace: "acme", roles: ["viewer"], via: "oidc" };
    const admin: Principal = { subject: "a", workspace: "acme", roles: ["admin"], via: "oidc" };
    expect(can(member, "teams:join")).toBe(true);
    expect(can(viewer, "teams:join")).toBe(false);
    expect(can(admin, "teams:join")).toBe(true);
    expect(can(member, "teams:write")).toBe(false); // joining yourself must not widen roster governance
  });

  it("rides the write api-key scope — a read-scoped key cannot mutate its own roster", () => {
    const readKey: Principal = {
      subject: "k",
      workspace: "acme",
      roles: ["member"],
      via: "api-key",
      scopes: ["read"],
    };
    const writeKey: Principal = { ...readKey, scopes: ["write"] };
    expect(can(readKey, "teams:join")).toBe(false);
    expect(can(writeKey, "teams:join")).toBe(true);
  });
});

describe("github:read — the read half of the workspace GitHub App integration", () => {
  const viewer: Principal = { subject: "v", workspace: "acme", roles: ["viewer"], via: "oidc" };
  const member: Principal = { subject: "u", workspace: "acme", roles: ["member"], via: "oidc" };
  const admin: Principal = { subject: "a", workspace: "acme", roles: ["admin"], via: "oidc" };

  // Reading the App's repos/files/issues used to ride settings:read, which is ADMIN-only. The write half
  // (github:write) has always been member+, so a member — and the conversational agent acting as one — could
  // open a pull request against a repository it was not allowed to read one file of. Whoever may write to the
  // integration's repositories may read them.
  it("sits at the SAME level as its write twin — a member holds both, a viewer neither", () => {
    expect(can(member, "github:read")).toBe(true);
    expect(can(member, "github:write")).toBe(true);
    expect(can(viewer, "github:read")).toBe(false);
    expect(can(viewer, "github:write")).toBe(false);
    expect(can(admin, "github:read")).toBe(true);
  });

  it("does not widen App GOVERNANCE — installing/unlinking stays admin-only settings:write", () => {
    expect(can(member, "settings:read")).toBe(false);
    expect(can(member, "settings:write")).toBe(false);
  });

  it("rides the READ api-key scope — reading a repository is reading, not governance", () => {
    const readKey: Principal = { subject: "k", workspace: "acme", roles: ["admin"], via: "api-key", scopes: ["read"] };
    expect(can(readKey, "github:read")).toBe(true);
    expect(can(readKey, "github:write")).toBe(false); // …while the write half still needs a write-scoped key
    expect(can(readKey, "settings:read")).toBe(false); // …and a read key still cannot read workspace governance
  });
});
