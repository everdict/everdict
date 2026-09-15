---
kind: wiki
title: "Agent execution auth — a credential for request-less agent turns"
status: current
updated: 2026-09-15
anchors: [packages/auth/src/agent-token.ts, packages/db/src/workspace/tenant-auth.ts, apps/api/src/composition/authenticator.ts, apps/agent/src/teammate-turn.ts]
---
# Agent execution auth — a credential for request-less agent turns

> A teammate ([agent-teams.md](./agent-teams.md)), a trigger-activated agent
> ([agent-automation.md](./agent-automation.md)), or any other headless agent turn runs **without a live HTTP
> request**, so there is no forwarded user bearer for the control-plane MCP tools it calls. It carries its own
> credential. Builds on [auth.md](../auth.md) (the control plane owns all auth; every credential resolves to a
> `Principal`).

## Problem

An interactive chat in `apps/agent` authenticates by **forwarding the caller's bearer**: the MCP client sends the
member's token to the control plane, so every tool call runs as that human (their role, their tenancy). A request-less
turn has no request, no header, no bearer — yet it still calls `get_scorecard` / `run_scorecard` / `create_task` as
*some* authenticated principal, scoped to its workspace and bounded in what it may do.

## Principles

1. **A credential kind, not a route special-case.** The control plane resolves every credential kind to one
   `Principal` behind `compositeAuthenticator` (`via`: `oidc` · `api-key` (`ak_`) · `runner` (`rnr_`) ·
   `github-actions` · `agent`). The autonomous agent credential is the `agt_` token with `via: "agent"` — one more
   `Authenticator`. No new tenancy axis, no bypass.
2. **Acts AS its creator, never above.** The token's `subject` is the member the agent acts for. Through the usual
   membership resolution (`applyActiveWorkspace`) it gets **that person's current workspace role** — it can never
   exceed them, and a role change or removal takes effect immediately.
3. **Scoped tighter than a person.** The token carries `scopes` (the per-key `read|write|admin` scope, intersected
   with the role by `can()`). Default = **`write`**, which excludes secrets, members, settings, keys and other
   governance — an autonomous agent authors and runs eval content but does not touch governance.
4. **Fail-closed, hashed, revocable, attributable.** Only the SHA-256 hash is stored (plaintext returned once at
   issuance). Unknown or revoked ⇒ `undefined` ⇒ 401. `via: "agent"` distinguishes autonomous actions from a
   human's.

## Design

```
request-less turn (teammate wake / trigger activation / scheduled report / …)
  → agent forwards  Authorization: Bearer agt_…   to /me + the MCP tools
      → agentTokenAuthenticator: agt_ prefix + hash → TenantKeyStore → { tenant, owner (creator), scopes }
      → Principal{ via:"agent", subject:owner, workspace, roles:["member"], scopes }
      → applyActiveWorkspace → the owner's membership role
      → can(principal, action) = role ∩ scopes
```

- **Authenticator** — `agentTokenAuthenticator({ resolve })` (`packages/auth/src/agent-token.ts`): matches the `agt_`
  prefix, hashes with `hashKey`, calls the injected `resolve`, fails closed. Returns `roles: ["member"]` as a
  bootstrap default and `scopes: resolved.scopes` or `["write"]` when none are stored.
- **Composition** — `buildAuthenticator` (`apps/api/src/composition/authenticator.ts`) places it in the composite
  chain, resolving through the same `TenantKeyStore` as `ak_` keys. The prefix check keeps `ak_` and `agt_` from
  cross-claiming a row.
- **Issuance** — `issueAgentToken(store, tenant, owner, scopes = ["write"], label?)`
  (`packages/db/src/workspace/tenant-auth.ts`) mints the token, stores its hash with the `agt_` prefix, and returns
  `{ token, id }` so the owning lifecycle can revoke by id. Token generation is in
  `packages/application-control/src/credential/credentials.ts`. Tokens are immutable (rotate = revoke + reissue).
- **Key list** — the personal key surface (`GET /keys` + `list_api_keys`) hides agent tokens via
  `isAgentTokenPrefix`; an `agt_` token is not a user-managed API key.
- **Membership** — `via: "agent"` is **not** excluded from `applyActiveWorkspace` (unlike `runner` and
  `github-actions`): the owner is a real member, so the token takes the owner's live role.

## Who mints a token, with what scope

Every issuer in `apps/agent` ties the token to the work's lifecycle and revokes it by id when that work ends.

| Turn | Owner | Scopes | Where |
|---|---|---|---|
| Teammate (spawn + boot restore) | the creator | `write` | `apps/agent/src/server.ts` |
| Trigger / subscription activation | the agent's creator | `write` | `apps/agent/src/agent-activation.ts` |
| Discussion turn (`@everdict` in a comment) | the asker | `read`, `write` | `apps/agent/src/discussion-turn.ts` |
| Scheduled report | the schedule's creator | `read` | `apps/agent/src/report-turn.ts` |
| Verification turn | the member acted for | `read` | `apps/agent/src/verification-turn.ts` |
| Wake-resume of a parked conversation | the session owner | `write` | `apps/agent/src/wake-resume.ts` |
| Try-drive (`POST /internal/try`) | the named member | `read` | `apps/agent/src/server.ts` |

## The request-less turn

`runTeammateTurn(deps, authenticate, mailbox, sessionId, agentToken, signal?, permit?, ledger?, envelope?)`
(`apps/agent/src/teammate-turn.ts`) authenticates with the `agt_` token, drains the session's mailbox, and runs the
agent loop over the incoming messages — forwarding the SAME token to the MCP tools, so every tool call is
authenticated and RBAC-bounded as the owner. It is the `TeammateSupervisor`'s turn function and the default
activation turn. Best-effort: a failed turn is logged and returns `undefined`, never thrown.

## Non-goals / guardrails

- Not a super-user token — bounded by the owner's role AND the token's scope.
- Not a second tenancy axis — `workspace` stays the one trust-zone key; the token is workspace-scoped.
- Not decode-without-verify — resolved only via the hashed store; unknown ⇒ 401.
