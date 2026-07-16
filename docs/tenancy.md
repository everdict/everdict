# Tenant access layer (harness ownership + scoped reads)

How a tenant actually uses the SaaS: authenticate (see **`docs/auth.md`** for the auth core), register/own
**harnesses**, submit runs, and see only **their own** data. `workspace === tenant === trust-zone key`: the
runtime tenant-machinery (fairness, isolation, budgets, warm-pool separation, result store) is already keyed by
`tenant`; the auth core supplies a *real, non-spoofable* `workspace` for that key, plus a role.

## Authentication (recap — full detail in `docs/auth.md`)
Two credentials both resolve to a `Principal{ subject, workspace, roles, via }`:
- **Humans** → Keycloak **OIDC** JWT (via `apps/web`), `via:"oidc"`.
- **Agents / MCP / CI** → **API key** `ak_…` (`Authorization: Bearer ak_…`), `via:"api-key"`.

Only the **SHA-256 hash** of a key is stored (`everdict_tenant_keys`), never the plaintext. With
`EVERDICT_REQUIRE_AUTH=1` a missing/invalid credential is **401**; in dev (default) it falls back to the
`x-everdict-tenant` header (admin). **Key issuance** is operator-only: `POST /internal/tenant-keys` guarded by
`x-internal-token` (constant-time, **fail-closed** if unset); the plaintext key is returned **once**.

```bash
curl -XPOST $API/internal/tenant-keys -H 'x-internal-token: <T>' -d '{"workspace":"acme"}'   # → { workspace, apiKey }
```

## Workspaces (self-serve membership + switching)
A user (subject) can belong to **multiple workspaces**, each with a role. Membership is the control plane's
SSOT (`@everdict/db` `WorkspaceStore`: `everdict_workspaces` + `everdict_workspace_members(workspace, subject, role, email)`) —
Keycloak supplies the **identity** (subject); the token's `workspace` claim is only a **bootstrap default**. The
opaque `sub` is the identity key; the token's `email`/`preferred_username` claim is captured into the membership
row on each login (display only — for a human-readable member list, never an authz input).

- `POST /workspaces` `{name, id?}` — self-serve create (any authenticated principal); the creator becomes the
  workspace's **admin** member. `id` is the tenant key (slug); derived from `name` if omitted, **409** on an
  explicit-id conflict.
- `GET /workspaces` — list the caller's memberships (`{id, name, role, logoUrl?}`); also embedded in `GET /me.workspaces`.
- **Workspace metadata** (singular `/workspace`, distinct from plural `/workspaces`): `GET /workspace`
  (`settings:read`) returns the active workspace record `{id, name, owner, logoUrl?, createdAt}`; `PATCH /workspace`
  `{name?, logoUrl?}` (`settings:write`, admin) edits the **display name** and **logo** (logo is an image ref —
  http(s) URL or `data:image` base64, like a user avatar; empty string clears it). The **`id`/slug is immutable** —
  it is the tenant scope key for every table, so the web shows the URL read-only.
- `DELETE /workspace` — **owner-only** hard delete (the creator stored as `WorkspaceRecord.owner`; not a role —
  a non-owner admin gets 403). It **cascades**: `WorkspaceStore.delete(id)` removes every workspace/tenant-scoped
  row (members, settings, secrets, connections, invites, runs, scorecards, all registry tables, tenant keys) then
  the workspace row last (sequential + idempotent — `SqlClient` has no transaction). The web gates the danger zone
  on `owner === subject` and requires typing the workspace name to confirm.
- **Active workspace** is resolved per request in `apps/api` (`applyActiveWorkspace`): the `x-everdict-workspace`
  header (set by the web from a httpOnly cookie / the sidebar switcher) selects which membership scopes this
  request; `Principal.workspace`+`roles` come from that membership. The token/dev default workspace is
  **bootstrapped** into a membership on first use (existing Keycloak users stay seamless). A non-member
  `x-everdict-workspace` **falls back** to the default (isolation-safe; never a 403 from a stale selection).
- **Roles are workspace-governed, not derived from the Keycloak realm role.** A workspace role is admin only via
  (a) creating it (`POST /workspaces` → creator is admin), (b) an invite that grants it, or (c) an admin
  promotion. The bootstrap caps the role: a **fresh** workspace (de-facto creator) or a **machine key** (issuance
  is admin-gated) keeps the token's role, but a **human (OIDC)** bootstrapping into an **existing** workspace
  joins as **member** — so a global Keycloak `admin` realm role can never grant admin in someone else's workspace.
- One service core (`WorkspaceService`), two transports — HTTP routes **and** MCP tools (`list_workspaces` /
  `create_workspace` / `get_workspace` / `update_workspace` / `delete_workspace`). The web surfaces it as a
  Linear-style sidebar **workspace switcher** + create flow, plus a Settings **General** card (logo/name +
  read-only URL) and an owner-only **danger zone** (`docs/web.md`).

### Member management + invites (`MembershipService`)
Managing **who** is in a workspace and **how they join** — one service core, HTTP + MCP parity.
- **Members** — `GET /members` (`members:read`, viewer+ — seeing the team is benign) lists `{subject, role, email?,
  addedAt}`; `PATCH /members/:subject {role}` and `DELETE /members/:subject` (`members:write`, **admin**) change a
  role / remove. The **last admin can't be demoted or removed** (409) — no workspace is left admin-less. MCP:
  `list_members` / `set_member_role` / `remove_member`.
- **Invites (token/link redemption)** — `POST /invites {role, expiresInHours?}` (`members:write`, admin) mints a
  one-time token `inv_…` (returned **once**, hash-only at rest like API keys); share the link. `GET /invites`
  (admin) lists pending invites (meta only); `DELETE /invites/:id` revokes. **`POST /invites/accept {token}`** is
  authenticated-only (NOT workspace-role-gated, like `POST /workspaces`) — a logged-in **human** (api-key principals
  rejected) redeems it to join with the invite's role and is returned `{workspace, role}`. Invites are **single-use**
  (atomic CTE consume — concurrent double-redeem → 409), **expirable**, and an existing member who redeems keeps their
  current role (a shared link can't change privileges). Revoked == unknown (404, no existence leak). MCP:
  `create_invite` / `list_invites` / `revoke_invite` / `accept_invite`.

## Tenant-owned harnesses (`@everdict/registry`)
The harness registry is keyed by **`(tenant, id, version)`**. A tenant registers and lists only its own
harnesses; resolution falls back to the **`_shared`** owner for first-party harnesses (e.g. the file-loaded
`browser-use` spec), so tenants can run shared harnesses without owning them while keeping their own private.

| Method | Path | Action (role) | Effect |
|---|---|---|---|
| `POST` | `/harnesses` | `harnesses:register` (**admin**) | register a `HarnessSpec` under the caller's workspace (immutable; re-register-different → **409**) |
| `POST` | `/harnesses/validate` | `harnesses:register` (**admin**) | dry-run: schema + the workspace's own `existingVersions`/`versionExists` (no write) — the registration flow's pre-check |
| `GET`  | `/harnesses` | `harnesses:read` (viewer+) | list the workspace's own + `_shared` (`{id, owner, versions}`) |
| `GET`  | `/harnesses/:id` | `harnesses:read` (viewer+) | versions of that harness visible to the workspace (404 if none) |

`POST /runs` requires `runs:submit` (**member+**); `GET /runs`, `GET /runs/:id` require `runs:read` (viewer+).
All are workspace-scoped: a tenant can only see and act on its own runs (another workspace's run → **404**).

## Tenant-owned datasets (`@everdict/registry`)
Datasets reuse the identical ownership model — keyed by **`(tenant, id, version)`**, owner-first with `_shared`
fallback (first-party benchmark datasets seeded from `examples/datasets`), immutable versions. They are
**harness-agnostic** (one dataset, many `harness@version`s). The one difference from harnesses: writes are
**member+**, not admin (datasets are collaborative eval *content*; harness specs define execution → admin).

| Method | Path | Action (role) | Effect |
|---|---|---|---|
| `POST` | `/datasets` | `datasets:write` (**member+**) | register a `Dataset` under the caller's workspace (immutable → **409**) |
| `POST` | `/datasets/validate` | `datasets:write` (**member+**) | dry-run: schema + own `existingVersions`/`versionExists` (no write) |
| `GET`  | `/datasets` | `datasets:read` (viewer+) | list own + `_shared` (`{id, owner, versions}`) |
| `GET`  | `/datasets/:id/versions/:version` | `datasets:read` (viewer+) | full `Dataset` incl. cases (`version` may be `latest`; other workspace → **404**) |

See `docs/datasets.md`.

## Agent Judges (`@everdict/registry`)
Judges reuse the identical ownership model — `(tenant, id, version)`, owner-first with `_shared` fallback
(no first-party judges are auto-seeded; a workspace registers its own), immutable versions. A judge is `model` (LLM/VLM call) or
`harness` (delegate to a registered harness). Writes are **member+** (users self-register their judges).

| Method | Path | Action (role) | Effect |
|---|---|---|---|
| `POST` | `/judges` | `judges:write` (**member+**) | register a `JudgeSpec` (immutable → **409**) |
| `POST` | `/judges/validate` | `judges:write` (**member+**) | dry-run: schema + own `existingVersions`/`versionExists` (no write) |
| `GET`  | `/judges` | `judges:read` (viewer+) | list own + `_shared` (`{id, owner, versions}`) |
| `GET`  | `/judges/:id/versions/:version` | `judges:read` (viewer+) | full `JudgeSpec` (`version` may be `latest`; other workspace → **404**) |

See `docs/judges.md`.

## Runtimes (tenant execution infrastructure)
Runtimes reuse the same ownership model — `(tenant, id, version)`, owner-first with `_shared` fallback,
immutable versions. A runtime is `local` | `nomad` | `k8s` (no secrets in the spec). Writes are **admin**
(defining execution infra = placement/security, like `harnesses:register`). `POST/GET /runtimes`
(+`/validate`, `/:id/versions/:version`); `runtimes:read` = viewer+, `runtimes:write` = admin. At dispatch the
`RuntimeDispatcher` builds the tenant's chosen runtime (credentials from the tenant SecretStore) and routes via
the Scheduler. See `docs/runtimes.md`.

## Scorecards (batch evals)
`POST /scorecards` (a dataset × `harness@version` → aggregated `Scorecard`) requires `scorecards:run`
(**member+**); `GET /scorecards`, `GET /scorecards/:id` require `scorecards:read` (viewer+). All
workspace-scoped (another workspace's scorecard → **404**); the dataset is resolved with the same
owner-first/`_shared` rule. See `docs/scorecards.md`.

## Live-verified (real Postgres)
`EVERDICT_REQUIRE_AUTH=1 EVERDICT_INTERNAL_TOKEN=… DATABASE_URL=… node apps/api/dist/main.js`, then: issue keys for
`acme`/`beta` → no-key request is `401` → `acme` registers `bu@1.0.0` (`201`) → `acme` lists it, `beta` sees `[]`
(isolation) → mutated re-register is `409` → the row is `acme | bu | 1.0.0` in `everdict_harnesses`.

## Not yet (next)
Per-key scopes/expiry; rotating keys. (Workspace **member invites + role management** shipped — see
`MembershipService` above: token/link invites + member role/remove with last-admin protection.)
