# Harness version registry (`@everdict/registry`)

The **single source of truth for harness versions**: resolve `(id, version) → HarnessSpec`. An `CaseJob`
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

### Handing an entity to another team (`moveToTeam`)
The owning team (`team_id`, migration `0106`) is registry metadata beside `created_by`, so it can be **changed**
without touching content — which is the whole reason it lives outside the versioned spec. `moveToTeam(tenant, id,
teamId)` on the harness-instance / harness-template / dataset / judge registries is that change:

- **Entity-wide, never per version.** Reads answer ownership off the newest own version (`teamOfEntity`), so a
  split id would change owner the next time somebody registered a release. Tombstoned versions move too — a
  tombstone is revived by re-registering identical content, and it must not come back under the team that no
  longer owns the id.
- **Tenant directly-owned and live only.** A `_shared` first-party entry is not a workspace's to re-file, and an
  id whose every version is a tombstone is invisible to every read → `NotFoundError` for both, no separate check.
- **No version is minted** and `specsEqual`/immutability are untouched: nothing about the content changed.
- Authorization is the CALLER's (`moveCapabilityToTeam` in `@everdict/application-control`) — the same split
  `softDelete` follows. It authorizes BOTH the source and the destination team, on the entity's existing
  content-mutation action, and emits `<subject>.moved`. See `docs/auth.md` §The team axis.

## Rubrics (`RubricRegistry`)
Rubrics — HOW to judge: freeform `text` and/or named `criteria` plus an optional `promptTemplate`
(`docs/architecture/eval-domain-model.md` S3) — are their own versioned entity, mirroring the judge registry:
`register / get / has / versions / ownVersions / list`, `(tenant, id, version)` keyed, **immutable** versions
(different content → `ConflictError`), owner-first + `_shared` fallback, and explicit file seeding via `loadRubricDir`
(default owner `_shared`; `apps/api` no longer auto-seeds rubrics on boot).
`InMemoryRubricRegistry` (dev/test) + `PgRubricRegistry` (Postgres, `rubric` jsonb, PK `(tenant,id,version)`,
migration `0053_create_rubrics`). One rubric serves many judges: `JudgeSpec.rubric` accepts `{id, version}` as
well as the inline string, resolved at judge-run time (see `docs/judges.md`). The HTTP/MCP surface
(`POST/GET /rubrics`, `create/validate/list/get_rubric`) reuses the **judging-domain** actions
(`judges:read`/`judges:write` — no new authz action, like views reuse `scorecards:*`). Rubrics carry
version tags like the other version entities (see below; `tags` column via migration `0054_rubric_version_tags`).

## Version tags (mutable registry metadata)
Version numbers alone are hard to tell apart, so every versioned entity (harness instance / dataset / judge /
runtime / rubric) supports **per-version free-form tags** (e.g. `baseline`, `gpt-5 experiment`). Tags are **registry
metadata outside the immutable spec** — same layer as `createdBy` — so they can be edited *after* registration (the
whole point: label versions that already exist) and never participate in `specsEqual`/immutability. Contract on all
five registries:
- `setVersionTags(tenant, id, version, tags)` — full-array replace (empty = remove all). **Tenant-owned live
  versions only** (no `_shared` fallback — first-party versions can't be tagged), else `NotFoundError`; tombstoned
  versions are excluded like every other read/write.
- `versionTags(tenant, id)` → `Record<version, string[]>` (only versions that have tags). Reads resolve
  owner-first with `_shared` fallback, same visibility as `versions()`.
- List entries (`HarnessListEntry`/`DatasetListEntry`/`JudgeListEntry`/`RuntimeListEntry`/`RubricListEntry`) carry
  an optional `versionTags` map; `GET /harnesses/:id` includes it too.
Postgres stores tags in a `tags jsonb NOT NULL DEFAULT '[]'` column (migration `0047_version_tags`; rubrics via
`0054_rubric_version_tags`). HTTP surface:
`PUT /{harnesses,datasets,judges,runtimes,rubrics}/:id/versions/:version/tags` gated by each entity's
content-mutation action (`harnesses:register` / `datasets:write` / `judges:write` / `runtimes:write` — rubrics
reuse `judges:write` like the rest of their surface; no new authz action); MCP
parity via `set_*_version_tags`. Input is normalized in `apps/api` `version-tag-service.ts` (trim, drop empties,
order-preserving dedupe; ≤20 tags × ≤60 chars).

## Where a version came from (`origin`)

`created_by` answers WHO registered a version; **`origin`** answers why it exists at all — the issue whose
problem it was built to evaluate, the agent and conversation that shaped it, the channel the registration came
through. Without it a judge an agent authored from an issue arrives anonymous: the detail view can name its
creator and its content and nothing else, and "why does this exist" has no answer once the conversation scrolls
away.

`CapabilityOrigin` (`@everdict/contracts`, `records/capability-origin.ts`):

```ts
{ via: "web" | "mcp" | "ci" | "import",
  from?: { type: "issue" | "scorecard" | "run" | …, id, version?, label? },
  agentId?, agentName?, conversationId?, runId?, note? }
```

Three rules make it work:

- **Metadata beside the spec, never inside it** — the same layer `created_by`, `team_id` and version tags live
  on. Versions are immutable, so a spec-resident origin would mean two versions born from the same issue stop
  being comparable, and re-stating where something came from would mint a version of unchanged content. It is
  excluded from `specsEqual`, so a differing origin is never a 409.
- **First answer wins.** `register` fills an UNSTAMPED version and never rewrites a stamped one (`origin IS NULL`
  is the guard, exactly like the team-adoption rule beside it): re-registering identical content is not a second
  birth.
- **Record-embedded, not derived from the event log.** The `*.registered` facts are swept
  (`deleteOlderThan`), and "why does this judge exist" is asked long after — the same reasoning behind the
  tracker's durable per-record history.

Assembly is one helper (`apps/api` `api/capability-origin.ts`), so both transports produce the same stamp: the
route/tool decides `via`, the agent identity comes from the attribution the caller already carries
(`x-everdict-agent-id` / `-name` / `-conversation-id`, the same headers `RevisionedWorkspaceFs` records), and
`from` is DECLARED — an `origin` sibling on the register body (the spec schema strips it) or the `fromIssue` /
`originNote` arguments on `create_judge` / `create_dataset` / `create_harness`. A declared **issue** reference is
resolved to the issue's stable record id with its identifier+title snapshotted as `label`, because `ENG-12` is
re-minted when an issue moves team.

Storage: an `origin jsonb` column on every versioned table (migration `0111_capability_origin`), read back
defensively (`parseCapabilityOrigin` — a malformed stamp degrades to "unknown origin" and never breaks the list
that carries it). List entries expose `versionOrigins: Record<version, CapabilityOrigin>` (only stamped
versions), the same grain as `versionTags`, so the detail views read it without a new endpoint. Rows registered
before the migration stay NULL and stay that way: an origin invented after the fact is a guess wearing the
clothes of a record. Their tie to an issue surfaces through the reverse read instead
(`GET /issues?linkType=judge&linkId=…`).

**A capability born from an issue links itself back to it** — `withOriginBacklink` (`@everdict/application-control`),
a composition-root decorator paired with `withRegisteredFact`. See `docs/tracker.md`.
