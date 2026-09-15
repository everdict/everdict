---
kind: wiki
title: "Versioned registries (@everdict/registry)"
status: current
updated: 2026-09-15
anchors: [packages/registry/src/index.ts, packages/registry/src/versioned-store.ts, packages/application-control/src/ports/harness-instance-registry.ts, packages/registry/src/harness/load-harness-taxonomy.ts, packages/application-control/src/version-tag/version-tag-service.ts]
---
# Versioned registries (`@everdict/registry`)

The **single source of truth for versioned eval assets**: resolve `(tenant, id, version) → spec`. A `CaseJob`
carries only `harness: {id, version}` — a *reference*; the registry turns that reference into the concrete spec
(services, deps, target, front-door, trace source for a service harness; command/model for a command harness).

The package holds one registry per versioned entity, each an `InMemory*` (dev/test) + `Pg*` pair implementing a
port in `@everdict/application-control` (`ports/*-registry.ts`): harness templates, harness instances, datasets,
judges, rubrics, models, agents, runtimes, environments and benchmarks.

## Contract (the shared versioned store)
The registries sit on one algebra (`VersionedStore` / `PgVersionedStore`, version algebra in `@everdict/domain`
`registry/version-algebra.ts`); some expose a narrower surface (benchmarks carry no tags or soft delete):
- `register(tenant, spec, createdBy?, origin?)` — versions are **immutable**: re-registering the same
  `(id, version)` with an identical spec is idempotent (and revives a soft-deleted version); with a different spec
  it throws `ConflictError`. Equality is `specsEqual`, a key-order-independent compare (so `jsonb` round-trips match).
- `get(tenant, id, ref?)` — `ref` is an exact version or `"latest"` (default). Unknown id/version → `NotFoundError`.
- `versions(tenant, id)` — sorted (semver-aware: `1.10.0 > 1.9.0`; non-semver keeps registration order).
  `ownVersions(tenant, id)` — only what this tenant registered directly (no `_shared` fallback).
- `list(tenant)` — every id with its versions and list metadata.

`"latest"` resolves to the highest semver (or last-registered if not semver).

## Harnesses — template + instance
A harness is authored in two levels (`docs/architecture/harness-taxonomy.md`): a **template** (the shape —
services/dependencies/slots, versions unpinned; `HarnessTemplateRegistry`) and an **instance** (a template
reference + pins; `HarnessInstanceRegistry`). The instance registry resolves the pair into the `HarnessSpec`
backends consume:
- `getInstance(tenant, id, ref?)` — the stored instance; `get(tenant, id, ref?)` — resolved (template + pins).
- `getService(tenant, id, ref?)` — resolved and narrowed to a `ServiceHarnessSpec` (`BadRequestError` otherwise).
- `resolveWithPins(tenant, id, ref, pins)` — resolved with submit-time transient pins (a CI trigger swapping one
  service image); an unknown slot is a `BadRequestError`, never ignored.
- `softDelete`, `creatorOf`/`creatorOfVersion` (private harnesses that reference a personal secret).

## Declarative SSOT (files / GitOps)
`loadHarnessTaxonomyDir(dir, { templates?, instances?, tenant? })` builds (or seeds) the two registries from a
directory: `*.template.json` → `HarnessTemplateSpec`, `*.instance.json` → `HarnessInstanceSpec`, templates first.
Version-controlled files are reviewable, immutable, diffable. See `examples/harness-templates/`
(`bu.template.json` + `bu-1.1.0.instance.json`).

```jsonc
// examples/harness-templates/bu-1.1.0.instance.json
{ "template": { "id": "bu", "version": "1" }, "id": "bu", "version": "1.1.0",
  "pins": { "agent-server": "mendhak/http-https-echo:latest" } }
```

It is the only file loader: datasets, judges, rubrics, models and runtimes are registered through the API
(REST and MCP), and nothing in `apps/` seeds from files on boot.

## How it plugs in
`ServiceTopologyBackend` takes `specFor: (tenant, id, version) => ServiceHarnessSpec` — wire it straight to the
instance registry:
```ts
const { instances } = await loadHarnessTaxonomyDir("examples/harness-templates");
new ServiceTopologyBackend({ runtime, traceSource, specFor: (tenant, id, ref) => instances.getService(tenant, id, ref), ... });
```
A job that references `version: "latest"` is resolved to the concrete version at dispatch, so scorecards and
regression name an exact version.

Live-verified on the local kind cluster (`scripts/live/registry-k8s.mjs`): load the dir → resolve `bu@latest` →
`1.1.0` → drive a real K8s service-topology run with the registry-resolved spec.

## Persistence (`PgHarnessTemplateRegistry` / `PgHarnessInstanceRegistry`)
The ports are async, so the Postgres impls are drop-ins: each version is a row in `everdict_harness_templates` /
`everdict_harness_instances` (`spec` as `jsonb`, PK `(tenant, id, version)`, migration
`0016_create_harness_taxonomy`), sharing the `@everdict/db` `SqlClient` + migrator and the same immutability. Seed
them from the file SSOT with `loadHarnessTaxonomyDir(dir, { templates: pgTemplates, instances: pgInstances })`.

Live-verified against real Postgres (`scripts/live/pg-harness-registry.mjs`): migrate → seed files → resolve
`bu@latest` → `1.1.0` → re-register-different-spec is rejected → spec survives a fresh connection.

## Tenant ownership
Every registry is keyed by **`(tenant, id, version)`**. Resolution prefers the tenant's own version and falls back
to the **`_shared`** owner for first-party assets (the file loaders register under `_shared` by default; pass
`tenant` to choose the owner). The HTTP surface (`POST/GET /harnesses`, authed) exposes this per-tenant — see
`docs/tenancy.md`.

## Rubrics (`RubricRegistry`)
Rubrics — HOW to judge: freeform `text` and/or named `criteria` plus an optional `promptTemplate`
(`docs/architecture/eval-domain-model.md` S3) — are their own versioned entity, mirroring the judge registry:
`register / get / has / versions / ownVersions / list`, `(tenant, id, version)` keyed, **immutable** versions
(different content → `ConflictError`), owner-first + `_shared` fallback.
`InMemoryRubricRegistry` (dev/test) + `PgRubricRegistry` (Postgres, `rubric` jsonb, PK `(tenant,id,version)`,
migration `0053_create_rubrics`). One rubric serves many judges: `JudgeSpec.rubric` accepts `{id, version}` as
well as the inline string, resolved at judge-run time (see `docs/judges.md`). The HTTP/MCP surface
(`POST/GET /rubrics`, `create/validate/list/get_rubric`) reuses the **judging-domain** actions
(`judges:read`/`judges:write` — no new authz action, like views reuse `scorecards:*`). Rubrics carry
version tags like the other version entities (see below; `tags` column via migration `0054_rubric_version_tags`).

## Environments (`EnvironmentRegistry`)
An environment — the world a case ACTS ON (a seed repository, a browser fixture, a prompt context, a desktop),
as opposed to the harness that acts — is its own versioned entity, keyed `(tenant, id, version)`, immutable
per version, owner-first with a `_shared` fallback, with version tags and capability origin like every sibling.
`InMemoryEnvironmentRegistry` + `PgEnvironmentRegistry` (`environment` jsonb, migration
`0207_create_environments`). An environment may carry its own **image** — an in-compute world (a repo at a
commit, a desktop with its apps) is delivered as the container the actor runs in, so the world's bytes belong
to the world; a referencing case takes the image from the environment, and a case that names a DIFFERENT
image for that world is refused rather than resolved by precedence
(`docs/architecture/world-and-engagement-model.md`). A case names one with `env: { kind: "ref", id, version? }`; the control plane
resolves it before dispatch and SEALS the concrete version on the batch's manifest, so a batch can be re-run
against exactly the world it measured and two batches over one dataset and two environment versions read as an
`environment` confound rather than as a change to the harness under test. The HTTP/MCP surface
(`POST/GET /environments`, `create/list/get_environment`, `set_environment_version_tags`) reuses the
**dataset** actions (`datasets:read`/`datasets:write` — no new authz action, like rubrics reuse `judges:*`):
an environment is part of what an evaluation asks. Design: `docs/architecture/harness-definability-spec.md` §2.

## Version tags (mutable registry metadata)
Version numbers alone are hard to tell apart, so the versioned entities (harness instance / dataset / judge /
runtime / rubric / environment) support **per-version free-form tags** (e.g. `baseline`, `gpt-5 experiment`). Tags are **registry
metadata outside the immutable spec** — same layer as `createdBy` — so they can be edited *after* registration (the
whole point: label versions that already exist) and never participate in `specsEqual`/immutability. Contract on
those registries:
- `setVersionTags(tenant, id, version, tags)` — full-array replace (empty = remove all). **Tenant-owned live
  versions only** (no `_shared` fallback — first-party versions can't be tagged), else `NotFoundError`; tombstoned
  versions are excluded like every other read/write.
- `versionTags(tenant, id)` → `Record<version, string[]>` (only versions that have tags). Reads resolve
  owner-first with `_shared` fallback, same visibility as `versions()`.
- List entries (`HarnessListEntry`/`DatasetListEntry`/`JudgeListEntry`/`RuntimeListEntry`/`RubricListEntry`/
  `EnvironmentListEntry`) carry an optional `versionTags` map; `GET /harnesses/:id` includes it too.
Postgres stores tags in a `tags jsonb NOT NULL DEFAULT '[]'` column (migration `0047_version_tags`; rubrics via
`0054_rubric_version_tags`). HTTP surface:
`PUT /{harnesses,datasets,judges,runtimes,rubrics,environments}/:id/versions/:version/tags` gated by each entity's
content-mutation action (`harnesses:register` / `datasets:write` / `judges:write` / `runtimes:write` — rubrics
reuse `judges:write` and environments `datasets:write`, like the rest of their surfaces; no new authz action); MCP
parity via `set_*_version_tags`. Input is validated and normalized in `@everdict/application-control`
`version-tag/version-tag-service.ts` (`VersionTagsBodySchema` ≤20 tags × ≤60 chars; trim, drop empties,
order-preserving dedupe). The Capability Store (`/capabilities`) has its own tag route over the same normalizer.

## When a version arrived (`versionDates`)

`versionDates(tenant, id)` → `Record<version, ISO instant>` — each **live** version's registration time, on the
harness-instance / dataset / judge registries (in-memory + Pg; same owner-first `_shared`-fallback visibility as
`versions()`, tombstones excluded, unknown id = empty map). It exists for the product timeline's capability
lane — "the evaluation contract moved" is an event on the product's axis — and is **optional on the ports**
(`versionDates?`): a registry impl without it degrades to an empty lane, never a failed read.

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

- **Metadata beside the spec, never inside it** — the same layer `created_by` and version tags live on. Versions are immutable, so a spec-resident origin would mean two versions born from the same issue stop
  being comparable, and re-stating where something came from would mint a version of unchanged content. It is
  excluded from `specsEqual`, so a differing origin is never a 409.
- **First answer wins.** `register` fills an UNSTAMPED version and never rewrites a stamped one (`origin IS NULL` is the guard):
  re-registering identical content is not a second birth.
- **Record-embedded, not derived from the event log.** The `*.registered` facts are swept
  (`deleteOlderThan`), and "why does this judge exist" is asked long after — the same reasoning behind the
  tracker's durable per-record history.

Assembly is one helper (`apps/api` `api/capability-origin.ts`), so both transports produce the same stamp: the
route/tool decides `via`, the agent identity comes from the attribution the caller already carries
(`x-everdict-agent-id` / `-name` / `-conversation-id`, the same headers `RevisionedWorkspaceFs` records), and
`from` is DECLARED — an `origin` sibling on the register body (the spec schema strips it) or the `fromIssue` /
`originNote` arguments on `create_judge` / `create_dataset` / `create_harness`. A declared **issue** reference is
resolved to the issue's stable record id with its identifier+title snapshotted as `label`, because the
identifier is a name the record can be re-issued under (migration `0211` did exactly that) while the id is not.

Storage: an `origin jsonb` column on every versioned table (migration `0111_capability_origin`), read back
defensively (`parseCapabilityOrigin` — a malformed stamp degrades to "unknown origin" and never breaks the list
that carries it). List entries expose `versionOrigins: Record<version, CapabilityOrigin>` (only stamped
versions), the same grain as `versionTags`, so the detail views read it without a new endpoint. Rows registered
before the migration stay NULL and stay that way: an origin invented after the fact is a guess wearing the
clothes of a record. Their tie to an issue surfaces through the reverse read instead
(`GET /issues?linkType=judge&linkId=…`).

**A capability born from an issue links itself back to it** — `withOriginBacklink` (`@everdict/application-control`),
a composition-root decorator paired with `withRegisteredFact`. See `docs/tracker.md`.
