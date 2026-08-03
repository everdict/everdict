import { describe, expect, it } from "vitest";
import { authorize, can } from "./authz.js";
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

  it("still allows READING another team's resource — ownership filters lists, it does not hide the workspace", () => {
    expect(can(member, "harnesses:read", { teamId: "mobile" })).toBe(true);
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
