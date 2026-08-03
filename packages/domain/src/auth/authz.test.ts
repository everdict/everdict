import { describe, expect, it } from "vitest";
import { authorize, can, visibleTeams } from "./authz.js";
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

  it("refuses READING another team's resource too — a team's work is its own, not the workspace's noticeboard", () => {
    expect(can(member, "harnesses:read", { teamId: "mobile" })).toBe(false);
    expect(can(member, "scorecards:read", { teamId: "mobile" })).toBe(false);
    expect(can(member, "harnesses:read", { teamId: "web" })).toBe(true); // ...their own still reads
    expect(can(member, "harnesses:read", {})).toBe(true); // ...and so does an unowned one
  });

  it("keeps a machine credential outside the team axis — a runner/CI token has no roster to be isolated by", () => {
    const ci: Principal = { subject: "repo:acme/api", workspace: "acme", roles: ["ci"], via: "github-actions" };
    const runner: Principal = { subject: "rnr", workspace: "acme", roles: ["runner"], via: "runner" };
    expect(can(ci, "scorecards:read", { teamId: "mobile" })).toBe(true);
    expect(can(ci, "scorecards:run", { teamId: "mobile" })).toBe(true);
    expect(visibleTeams(ci)).toBeUndefined();
    expect(visibleTeams(runner)).toBeUndefined();
    // An agent credential is NOT exempt: it acts as its creator, so it is isolated with that person's teams.
    const agent: Principal = { subject: "u", workspace: "acme", roles: ["member"], via: "agent", teams: ["web"] };
    expect(can(agent, "scorecards:read", { teamId: "mobile" })).toBe(false);
    expect(visibleTeams(agent)).toEqual(["web"]);
  });

  it("gives a list read its ceiling: none for an admin, and [] — not 'everything' — for a member on no team", () => {
    expect(visibleTeams(admin)).toBeUndefined();
    expect(visibleTeams(member)).toEqual(["web"]);
    expect(visibleTeams(teamless)).toEqual([]);
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
