# Tenant access layer (auth + harness ownership)

How a tenant actually uses the SaaS: authenticate with an **API key**, register/own **harnesses**, submit runs,
and see only **their own** data. The runtime tenant-machinery (fairness, isolation, budgets, warm-pool
separation, result store) is already keyed by `tenant`; this layer supplies a *real, non-spoofable* identity.

## API-key authentication (`@assay/db`)
- Keys are `ak_<random>`; only the **SHA-256 hash** is stored (`assay_tenant_keys`), never the plaintext.
- `keyStoreAuth(store).authenticate(key) → tenant | undefined`. The API resolves `tenant` from
  `Authorization: Bearer ak_…`. With `ASSAY_REQUIRE_AUTH=1`, a missing/invalid key is **401**; in dev (default)
  it falls back to the `x-assay-tenant` header.
- **Key issuance** is operator-only: `POST /internal/tenant-keys` guarded by `x-internal-token` (constant-time
  compare, **fail-closed** if unset). The plaintext key is returned **once** in the response.

```bash
curl -XPOST $API/internal/tenant-keys -H 'x-internal-token: <T>' -d '{"tenant":"acme"}'   # → { tenant, apiKey }
```

## Tenant-owned harnesses (`@assay/registry`)
The harness registry is keyed by **`(tenant, id, version)`**. A tenant registers and lists only its own
harnesses; resolution falls back to the **`_shared`** owner for first-party harnesses (e.g. the file-loaded
`browser-use` spec), so tenants can run shared harnesses without owning them while keeping their own private.

| Method | Path | Auth | Effect |
|---|---|---|---|
| `POST` | `/harnesses` | Bearer | register a `HarnessSpec` under the caller's tenant (immutable; re-register-different → **409**) |
| `GET`  | `/harnesses` | Bearer | list the tenant's own + `_shared` (`{id, owner, versions}`) |
| `GET`  | `/harnesses/:id` | Bearer | versions of that harness visible to the tenant (404 if none) |

`POST /runs`, `GET /runs`, `GET /runs/:id` are all tenant-scoped: a tenant can only see and act on its own runs.

## Live-verified (real Postgres)
`ASSAY_REQUIRE_AUTH=1 ASSAY_INTERNAL_TOKEN=… DATABASE_URL=… node apps/api/dist/main.js`, then: issue keys for
`acme`/`beta` → no-key request is `401` → `acme` registers `bu@1.0.0` (`201`) → `acme` lists it, `beta` sees `[]`
(isolation) → mutated re-register is `409` → the row is `acme | bu | 1.0.0` in `assay_harnesses`.

## Not yet (next)
Self-service tenant signup/plans; per-key scopes/expiry; rotating keys; **per-tenant scored dashboard** over
these scoped reads (the original motivation — now unblocked).
