# Tenant access layer (harness ownership + scoped reads)

How a tenant actually uses the SaaS: authenticate (see **`docs/auth.md`** for the auth core), register/own
**harnesses**, submit runs, and see only **their own** data. `workspace === tenant === trust-zone key`: the
runtime tenant-machinery (fairness, isolation, budgets, warm-pool separation, result store) is already keyed by
`tenant`; the auth core supplies a *real, non-spoofable* `workspace` for that key, plus a role.

## Authentication (recap — full detail in `docs/auth.md`)
Two credentials both resolve to a `Principal{ subject, workspace, roles, via }`:
- **Humans** → Keycloak **OIDC** JWT (via `apps/web`), `via:"oidc"`.
- **Agents / MCP / CI** → **API key** `ak_…` (`Authorization: Bearer ak_…`), `via:"api-key"`.

Only the **SHA-256 hash** of a key is stored (`assay_tenant_keys`), never the plaintext. With
`ASSAY_REQUIRE_AUTH=1` a missing/invalid credential is **401**; in dev (default) it falls back to the
`x-assay-tenant` header (admin). **Key issuance** is operator-only: `POST /internal/tenant-keys` guarded by
`x-internal-token` (constant-time, **fail-closed** if unset); the plaintext key is returned **once**.

```bash
curl -XPOST $API/internal/tenant-keys -H 'x-internal-token: <T>' -d '{"workspace":"acme"}'   # → { workspace, apiKey }
```

## Workspaces (self-serve membership + 전환)
A user (subject) can belong to **multiple workspaces**, each with a role. Membership is the control plane's
SSOT (`@assay/db` `WorkspaceStore`: `assay_workspaces` + `assay_workspace_members(workspace, subject, role)`) —
Keycloak supplies the **identity** (subject); the token's `workspace` claim is only a **bootstrap default**.

- `POST /workspaces` `{name, id?}` — self-serve create (any authenticated principal); the creator becomes the
  workspace's **admin** member. `id` is the tenant key (slug); derived from `name` if omitted, **409** on an
  explicit-id conflict.
- `GET /workspaces` — list the caller's memberships (`{id, name, role}`); also embedded in `GET /me.workspaces`.
- **Active workspace** is resolved per request in `apps/api` (`applyActiveWorkspace`): the `x-assay-workspace`
  header (set by the web from a httpOnly cookie / the sidebar switcher) selects which membership scopes this
  request; `Principal.workspace`+`roles` come from that membership. The token/dev default workspace is
  **bootstrapped** into a membership on first use (existing Keycloak users stay seamless). A non-member
  `x-assay-workspace` **falls back** to the default (isolation-safe; never a 403 from a stale selection).
- One service core (`WorkspaceService`), two transports — HTTP routes **and** MCP tools (`list_workspaces` /
  `create_workspace`). The web surfaces it as a Linear-style sidebar **workspace switcher** + create flow
  (`docs/web.md`). Member invites / role management are the next slice.

## Tenant-owned harnesses (`@assay/registry`)
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

## Tenant-owned datasets (`@assay/registry`)
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

## Agent Judges (`@assay/registry`)
Judges reuse the identical ownership model — `(tenant, id, version)`, owner-first with `_shared` fallback
(first-party default judges from `examples/judges`), immutable versions. A judge is `model` (LLM/VLM call) or
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
`ASSAY_REQUIRE_AUTH=1 ASSAY_INTERNAL_TOKEN=… DATABASE_URL=… node apps/api/dist/main.js`, then: issue keys for
`acme`/`beta` → no-key request is `401` → `acme` registers `bu@1.0.0` (`201`) → `acme` lists it, `beta` sees `[]`
(isolation) → mutated re-register is `409` → the row is `acme | bu | 1.0.0` in `assay_harnesses`.

## Not yet (next)
Workspace **member invites + role management** (the membership store + create/switch/list shipped; inviting other
subjects and changing their role is the next slice); per-key scopes/expiry; rotating keys.
