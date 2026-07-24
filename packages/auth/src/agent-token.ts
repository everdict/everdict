import { hashKey } from "@everdict/db";
import type { Authenticator } from "./principal.js";

// Resolve an agent-token hash → the credential it stands for. Returns undefined for an unknown/revoked token
// (fail-closed → 401). `owner` = the human who created the teammate/proactive agent (the token acts AS them).
export interface AgentTokenResolution {
  workspace: string; // = tenant / trust-zone key
  owner: string; // the creator's subject — the token's identity
  scopes?: string[]; // per-token scope narrowing (read|write|admin); default write (no governance/secrets)
}

export interface AgentTokenAuthOptions {
  resolve: (hash: string) => Promise<AgentTokenResolution | undefined>;
}

// Autonomous agent execution credential (agt_) authenticator (docs/architecture/agent-execution-auth.md, A1). A
// teammate / proactively-woken agent has no live request, so it presents an agt_ token instead of a forwarded user
// bearer. The token acts AS its creator: subject = owner → applyActiveWorkspace grants the creator's CURRENT
// membership role (never above them), and the token's scope (default "write") caps it below governance/secrets via
// can()'s scope intersection. Fail-closed: an unknown/revoked token resolves to undefined → 401. `via:"agent"` keeps
// autonomous actions distinguishable from a human's in the audit trail.
export function agentTokenAuthenticator(opts: AgentTokenAuthOptions): Authenticator {
  return {
    async authenticate(bearer) {
      if (!bearer.startsWith("agt_")) return undefined;
      const resolved = await opts.resolve(hashKey(bearer));
      if (!resolved) return undefined;
      return {
        subject: resolved.owner,
        workspace: resolved.workspace,
        // Bootstrap default; applyActiveWorkspace overrides with the creator's live membership role (subject-based).
        roles: ["member"],
        via: "agent",
        // Autonomous agent: never governance/secrets by default — "write" excludes secrets/members/settings/keys.
        scopes: resolved.scopes && resolved.scopes.length > 0 ? resolved.scopes : ["write"],
      };
    },
  };
}
