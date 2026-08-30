import { describe, expect, it } from "vitest";
import { AgentMemberToolingService, workspaceSecretsBound } from "./agent-member-tooling-service.js";

// ── [R122 COUNTEREXAMPLE] A MEMBER MAY NOT SEND A WORKSPACE SECRET SOMEWHERE THEY CHOSE ─────────────
//
// The secret store decrypts values "injection-only" — its own word: a member never SEES a workspace secret,
// the platform injects it at execution. That premise holds only while the DESTINATION is trustworthy, and
// for a remote MCP capability the destination is `spec.url`:
//
//     capabilities:write   member+   (authz.ts: "authoring/publishing/adopting → member+")
//     secrets:write        admin     (authz.ts: "the credential 'value' is separately protected")
//     McpToolSpec.url      z.string().url()          ← the member authors it
//     secretBindings       logical → MY workspace's secret NAME  ← the member picks it
//     profile.ts           "the first declared required secret is the Authorization value"
//     resolveSecret        scoped.workspace[name] ?? scoped.user[name]   ← workspace tier FIRST
//
// So a member with no `secrets:read` could author a capability at `https://attacker/`, bind it to any
// workspace secret, run the agent, and the value would leave as an `Authorization` header.
//
//     the member cannot read the secret   ≠   the member cannot send it somewhere
//
// The personal tier is untouched: that is the member's own credential going where they choose.
//
// ⚠️ THE WIRING IS COMPILER-ENFORCED, which is why there is no fixture for it here. `bindToolSecrets` takes
// the entitlement as a REQUIRED parameter, so both transports failed to compile (TS2554, "Expected 6
// arguments, but got 5") until each passed `can(principal, "secrets:read")`. A test cannot prove a producer
// exists; a required parameter can, and rule `protocol` prefers it for exactly that reason.
//
// Seen RED before the guard: `bindToolSecrets` validated only that the logical NAME was declared and never
// looked at which secret the binding pointed AT.
describe("[R122 COUNTEREXAMPLE] binding a workspace secret is a privileged act", () => {
  const shared = ["OPENAI_KEY", "GITHUB_APP_KEY"];

  it("names every workspace secret a set of bindings reaches for", () => {
    const bound = workspaceSecretsBound({ Authorization: "GITHUB_APP_KEY", Other: "MY_OWN" }, shared);
    expect(bound, "a workspace credential was not recognised as privileged").toEqual(["GITHUB_APP_KEY"]);
  });

  it("says nothing about a purely personal binding — the member's own credential is theirs to route", () => {
    expect(workspaceSecretsBound({ Authorization: "MY_PERSONAL_TOKEN" }, shared)).toEqual([]);
  });

  it("reports each secret once, in a stable order — a refusal message has to be greppable", () => {
    const bound = workspaceSecretsBound({ A: "OPENAI_KEY", B: "OPENAI_KEY", C: "GITHUB_APP_KEY" }, shared);
    expect(bound).toEqual(["GITHUB_APP_KEY", "OPENAI_KEY"]);
  });

  it("the entitlement is a REQUIRED parameter of the binding call, not an option a caller may omit", () => {
    // An optional flag would default to permissive at every door somebody forgets — the shape rule `protocol`
    // calls out by name. `length` counts the declared parameters before the first default.
    expect(
      AgentMemberToolingService.prototype.bindToolSecrets.length,
      "the entitlement became optional — a door that omits it would bind workspace secrets silently",
    ).toBe(6);
  });
});
