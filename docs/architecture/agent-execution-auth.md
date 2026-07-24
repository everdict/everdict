# Agent execution auth — a credential for request-less agent turns

> **Status: doc-first SSOT (2026-07-24).** The crux dependency of
> [agent-teams.md](./agent-teams.md) S3 (teammates) / S4 (event bridge) / S5 (proactive): a teammate or a
> proactively-woken agent runs **without a live HTTP request**, so there is no forwarded user bearer for the
> control-plane MCP tools it calls. It needs its own credential. Builds on [auth.md](./auth.md) (the control
> plane owns all auth; every credential resolves to a `Principal`).

## Problem

Today the conversational agent (`apps/agent`) authenticates by **forwarding the caller's bearer**: the base
MCP client sends the user's token to the control plane, so every tool call runs as that human (their role,
their tenancy). That is exactly right for interactive chat — but a **teammate** (S3) or a **proactively-woken**
agent (S5) has no request, no header, no bearer. It still needs to call `get_scorecard` / `run_scorecard` /
`send_message` as *some* authenticated principal, scoped to its workspace and bounded in what it may do.

## Principles

1. **A new credential kind, not a route special-case.** Everdict already resolves several credential kinds to
   one `Principal` behind `compositeAuthenticator` (oidc · api-key `ak_` · runner `rnr_` · github-actions). An
   autonomous agent credential is another kind — `via: "agent"`, an `agt_…` token, one more `Authenticator`
   (the `runnerAuthenticator` least-privilege pattern is the template). No new tenancy axis, no bypass.
2. **Acts AS its creator, never above.** The token's `subject` is the human who created the teammate/proactive
   agent. Through the usual membership resolution (`applyActiveWorkspace`) it gets **that person's current
   workspace role** — so it can never exceed the creator, and a role change/removal takes effect immediately
   (no baked-in privilege).
3. **Scoped tighter than a person.** The token carries `scopes` (the existing per-key scope: `read|write|admin`,
   intersected with the role by `can()`). Default = **`write`**, which by the matrix excludes secrets, members,
   settings, keys, and destructive live-cluster control — an autonomous agent authors/runs eval content but
   never touches governance. (S6's eval-driving surface fits inside `write`.)
4. **Fail-closed, hashed, revocable, audited.** Only the SHA-256 hash is stored (plaintext returned once at
   issuance, like `ak_`). Unknown/expired ⇒ `undefined` ⇒ 401. Revoked when the teammate stops. `via:"agent"`
   makes every autonomous action distinguishable in logs from a human's.

## Design

```
request-less turn (teammate wake / proactive event)
  → agent forwards  Authorization: Bearer agt_…   to /me + the MCP tools
      → agentTokenAuthenticator: agt_ prefix + hash → store → { workspace, subject(creator), scopes }
      → Principal{ via:"agent", subject:creator, workspace, scopes:["write"] }
      → applyActiveWorkspace → creator's membership role
      → can(principal, action) = role ∩ scopes   (≤ creator, ≤ write)
```

- **Token** — `agt_<random>`; SHA-256 hash in an `AgentTokenStore` (reuses the `TenantKeyStore` shape:
  `resolveByHash(hash) → { tenant, owner=creator, scopes }`). Immutable (rotate = revoke + reissue).
- **Authenticator** — `agentTokenAuthenticator({ resolve })`: `agt_` prefix, `hashKey`, injected `resolve`,
  fail-closed. Returns `Principal{ via:"agent", subject, workspace, roles:["member"] (bootstrap default),
  scopes: resolved.scopes ?? ["write"] }`. Placed in the composite chain. **A1 = this slice.**
- **Membership** — `via:"agent"` is **NOT** excluded from `applyActiveWorkspace` bootstrap (unlike
  runner/github-actions): the agent IS the creator, a real member, so it takes the creator's live role. (Its
  `subject` already has a member row; nothing new is bootstrapped.)

## Stages

- **A1 — auth core.** `Principal.via += "agent"`; `agentTokenAuthenticator` (pure, injected resolver);
  export + ready for the composite. Unit-tested (prefix match, fail-closed, scope default, bounded). **← this slice.**
- **A2 — token store + issuance.** Mint `generateAgentToken()` (`agt_…`, landed), store the hash, issue/revoke
  tied to the teammate's lifecycle; plaintext once. **Store decision (open):**
  - *(a) reuse `TenantKeyStore`* — `add(tenant, hash, { owner: creator, scopes: ["write"], prefix: "agt_" })`;
    `agentTokenAuthenticator({ resolve: h => keyStore.resolveByHash(h) })`. No migration. The prefix check keeps
    `ak_`/`agt_` from cross-claiming (same hash table, different authenticator). **Caveat:** an `agt_` row would
    surface in the owner's `list_api_keys` unless that list filters `prefix !== "agt_"` — do that filter.
  - *(b) dedicated `AgentTokenStore`* (new table + migration) — clean separation + teammate-tied lifecycle, no
    key-list leak, at the cost of a migration + a parallel store.
  Lean (a) + the list filter for the first cut (no migration); revisit (b) if agent-token lifecycle diverges.
- **A3 — request-less turn auth.** `apps/agent` resolves an agent `Principal` from a stored `agt_` token
  (instead of forwarding a user header) for a teammate/proactive turn, and forwards that token to the MCP
  tools. This unblocks S3 `runTeammateTurn` and S5 proactive wake.

## Non-goals / guardrails

- Not a super-user token — bounded by the creator's role AND the `write` scope; never secrets/governance.
- Not a second tenancy axis — `workspace` stays the one trust-zone key; the token is workspace-scoped.
- Not decode-without-verify — resolved only via the hashed store; unknown ⇒ 401.
