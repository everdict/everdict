# Harness version registry (`@everdict/registry`)

The **single source of truth for harness versions**: resolve `(id, version) → HarnessSpec`. An `AgentJob`
carries only `harness: {id, version}` — a *reference*; the registry turns that reference into the concrete spec
(services, deps, target, front-door, trace source for a service harness; metadata for a process harness).

## Contract
`HarnessRegistry`:
- `register(spec)` — versions are **immutable**: re-registering the same `(id, version)` with an identical spec
  is idempotent; with a different spec it throws `ConflictError` (prevents silent drift — the whole point of an SSOT).
- `get(id, ref?)` / `getService(id, ref?)` — `ref` is an exact version or `"latest"` (default). `getService`
  narrows to a `ServiceHarnessSpec` (throws if the harness is a process). Unknown id/version → `NotFoundError`.
- `versions(id)` — sorted (semver-aware: `1.10.0 > 1.9.0`; non-semver keeps registration order).
- `list()` — every id with its versions.

`"latest"` resolves to the highest semver (or last-registered if not semver).

## Declarative SSOT (files / GitOps)
`loadHarnessDir(dir)` builds a registry from a directory of `*.json` `HarnessSpec` files (each validated by
`HarnessSpecSchema`). Version-controlled files are the authoritative source — reviewable, immutable, diffable.
See `examples/harnesses/` (`bu-1.0.0.json`, `bu-1.1.0.json`).

```jsonc
// examples/harnesses/bu-1.1.0.json
{ "kind": "service", "id": "bu", "version": "1.1.0", "services": [...], "frontDoor": {...}, "traceSource": {...} }
```

## How it plugs in
`ServiceTopologyBackend` takes `specFor: (id, ref) => ServiceHarnessSpec` — wire it straight to the registry:
```ts
const registry = loadHarnessDir("examples/harnesses");
new ServiceTopologyBackend({ runtime, traceSource, specFor: (id, ref) => registry.getService(id, ref), ... });
```
A job that references `version: "latest"` is resolved to the concrete version at dispatch; `CaseResult.harness`
records the resolved `id@version` (e.g. `bu@1.1.0`), so scorecards/regression always name an exact version.

Live-verified on the local kind cluster (`scripts/live/registry-k8s.mjs`): load the dir → resolve `bu@latest` →
`1.1.0` → drive a real K8s service-topology run with the registry-resolved spec.

## Persistence (`PgHarnessRegistry`)
`HarnessRegistry` is async, so a Postgres-backed impl is a drop-in: `PgHarnessRegistry` stores each version as a
row in `everdict_harnesses` (`spec` as `jsonb`, PK `(id, version)`), shares the `@everdict/db` `SqlClient` + migrator
(migration `0002_create_harnesses`), and enforces the same immutability (re-register with a different spec →
`ConflictError`, using an order-independent compare since `jsonb` doesn't preserve key order). Seed it from the
file SSOT with `loadHarnessDir(dir, pgRegistry)`. `latest`/semver resolution is identical to in-memory.

Live-verified against real Postgres (`scripts/live/pg-harness-registry.mjs`): migrate → seed files → resolve
`bu@latest` → `1.1.0` → re-register-different-spec is rejected → spec survives a fresh connection.

## Tenant ownership
The registry is keyed by **`(tenant, id, version)`** (migration `0004_harness_tenant`). Resolution prefers the
tenant's own harness and falls back to the **`_shared`** owner for first-party harnesses (the file loader
registers under `_shared` by default). `loadHarnessDir(dir, { into, tenant })` chooses the owner. The HTTP
surface (`POST/GET /harnesses`, authed) exposes this per-tenant — see `docs/tenancy.md`.

## Version tags (mutable registry metadata)
Version numbers alone are hard to tell apart, so every versioned entity (harness instance / dataset / judge /
runtime) supports **per-version free-form tags** (e.g. `baseline`, `gpt-5 실험`). Tags are **registry metadata
outside the immutable spec** — same layer as `createdBy` — so they can be edited *after* registration (the whole
point: label versions that already exist) and never participate in `specsEqual`/immutability. Contract on all four
registries:
- `setVersionTags(tenant, id, version, tags)` — full-array replace (empty = remove all). **Tenant-owned live
  versions only** (no `_shared` fallback — first-party versions can't be tagged), else `NotFoundError`; tombstoned
  versions are excluded like every other read/write.
- `versionTags(tenant, id)` → `Record<version, string[]>` (only versions that have tags). Reads resolve
  owner-first with `_shared` fallback, same visibility as `versions()`.
- List entries (`HarnessListEntry`/`DatasetListEntry`/`JudgeListEntry`/`RuntimeListEntry`) carry an optional
  `versionTags` map; `GET /harnesses/:id` includes it too.
Postgres stores tags in a `tags jsonb NOT NULL DEFAULT '[]'` column (migration `0047_version_tags`). HTTP surface:
`PUT /{harnesses,datasets,judges,runtimes}/:id/versions/:version/tags` gated by each entity's content-mutation
action (`harnesses:register` / `datasets:write` / `judges:write` / `runtimes:write` — no new authz action); MCP
parity via `set_*_version_tags`. Input is normalized in `apps/api` `version-tag-service.ts` (trim, drop empties,
order-preserving dedupe; ≤20 tags × ≤60 chars).
