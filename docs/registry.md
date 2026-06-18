# Harness version registry (`@assay/registry`)

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
row in `assay_harnesses` (`spec` as `jsonb`, PK `(id, version)`), shares the `@assay/db` `SqlClient` + migrator
(migration `0002_create_harnesses`), and enforces the same immutability (re-register with a different spec →
`ConflictError`, using an order-independent compare since `jsonb` doesn't preserve key order). Seed it from the
file SSOT with `loadHarnessDir(dir, pgRegistry)`. `latest`/semver resolution is identical to in-memory.

Live-verified against real Postgres (`scripts/live/pg-harness-registry.mjs`): migrate → seed files → resolve
`bu@latest` → `1.1.0` → re-register-different-spec is rejected → spec survives a fresh connection.

> Tenant ownership (a `tenant` column + scoped reads) is a future expand migration, landing with the tenant
> access layer (API keys → tenant). Today the registry is global.
