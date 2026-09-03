import { describe, expect, it } from "vitest";
import { can } from "./authz.js";
import type { Principal } from "./principal.js";

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
