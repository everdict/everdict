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

## Live-verified (real Postgres)
`ASSAY_REQUIRE_AUTH=1 ASSAY_INTERNAL_TOKEN=… DATABASE_URL=… node apps/api/dist/main.js`, then: issue keys for
`acme`/`beta` → no-key request is `401` → `acme` registers `bu@1.0.0` (`201`) → `acme` lists it, `beta` sees `[]`
(isolation) → mutated re-register is `409` → the row is `acme | bu | 1.0.0` in `assay_harnesses`.

## Not yet (next)
Self-service tenant signup/plans; per-key scopes/expiry; rotating keys; **per-tenant scored dashboard** over
these scoped reads (the original motivation — now unblocked; `apps/web` already forwards the Keycloak token and
gates UI off `GET /me` — see `docs/auth.md` + `docs/web.md`).
