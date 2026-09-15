---
kind: wiki
title: "Harness taxonomy — Template (category) + Instance (design)"
status: current
updated: 2026-09-15
anchors: [packages/contracts/src/harness/harness-template.ts, packages/registry/src/harness/harness-instance-registry.ts, apps/api/src/api/harness/harness-template.routes.ts, packages/domain/src/harness/instance-variation.ts]
---
# Harness taxonomy — Template (category) + Instance (design)

Every harness is authored as a **template** (the shape) plus an **instance** (pins and overrides on that shape).
There is no flat full-`HarnessSpec` registration path: the resolved `HarnessSpec` exists only as the dispatch
artifact `resolveHarnessInstance` produces.

Why: a harness used to be one self-contained spec keyed `(tenant, id, version)`. A topology and "the same topology
with one service bumped for PR #123" were two unrelated entries, so CI that registers per PR/SHA produced an
explosion of look-alike harnesses nobody could group.

## Model — two authoring concepts, one resolved spec

```
Template (category)         "the shape"          versions unpinned, declares slots
   └── Instance (harness)   "shape + pins"       pins each slot, may override knobs
            └── resolveHarnessInstance()  →  HarnessSpec (process|service|command)  →  dispatch
```

- **Template** — the structural skeleton: for a topology, which services + dependencies + target + frontDoor +
  traceSource, each versionable service a named **slot**. A template is versioned by **shape**: adding/removing a
  service or rewiring is a new template version; pinning an image is not. A service may carry a default `image`
  (`TemplateService.image`), so an instance pins only the slots it changes.
- **Instance** — a template reference + **pins** (slot → image; `image`/`model` for command templates) + optional
  structured **`overrides`**, plus an optional `description` (this version's changelog note, part of the
  version's immutable content, not carried into the resolved spec).
- **Resolved `HarnessSpec`** — template structure at the referenced version + pins + overrides. Nothing downstream
  of resolution knows about templates: `CaseJob.harness:{id,version}` still names a concrete, runnable thing.

## Schemas (`@everdict/contracts`)

`packages/contracts/src/harness/harness-template.ts` defines `HarnessTemplateSpecSchema` (a `kind`-discriminated
union of service / command / process templates; `category` is a free label such as `topology`, `cli-agent`,
`desktop`) and `HarnessInstanceSpecSchema`. Examples live in `examples/harness-templates/` as
`*.template.json` + `*.instance.json` pairs; they are not seeded on boot (`apps/api/src/core/harness/harness-seed.test.ts`
guards their validity).

```jsonc
// Template — structure once, slots instead of versions. Versioned by SHAPE.
{
  "category": "topology", "kind": "service",
  "id": "bu", "version": "1",
  "services": [
    { "name": "planner",       "slot": "planner",       "needs": [] },
    { "name": "browser",       "slot": "browser" },
    { "name": "action-stream", "slot": "action-stream", "needs": ["redis"] }
  ],
  "dependencies": [{ "store": "redis", "role": "bus", "isolateBy": "key-prefix" }],
  "frontDoor": { "service": "planner", "submit": "/run" },
  "traceSource": { "kind": "otel", "endpoint": "..." }
}

// Instance — template ref + pins (delta only). Typically one per PR/SHA.
{
  "template": { "id": "bu", "version": "1" },
  "id": "bu", "version": "pr-123-sha-abc",
  "description": "planner prompt rework + bump browser to 119",
  "pins": {
    "planner":       "ghcr.io/acme/bu-planner:abc123",
    "browser":       "chromedp/headless-shell:119",
    "action-stream": "ghcr.io/acme/bu-action:abc123"
  }
}
```

## Registry & resolution (`@everdict/registry`)

- **Template registry** (`HarnessTemplateRegistry`, in-memory + Pg): `(tenant, id, version) → HarnessTemplateSpec`.
  Immutable versions (re-registering a different shape → `ConflictError`), tenant-owned with `_shared` fallback.
- **Instance registry** (`HarnessInstanceRegistry`, in-memory + Pg): `(tenant, id, version) → HarnessInstanceSpec`.
  `register` loads the template and refuses an instance that does not resolve. `get(tenant, id, ref)` loads the
  instance, loads its template, and returns `resolveHarnessInstance(template, instance)`; `getInstance` returns the
  raw instance. `latest` = semver order, else last-registered.
- `HarnessInstanceSpec.id` is free: several harnesses can ride one template ("same shape, different env"), and
  the list carries derived `templateId`/`templateVersion` (`enrichHarnessList`) to group them.

## Permissions — "category, not role"

`packages/domain/src/auth/authz.ts`: `harnesses:read`, `harnesses:register` (instances) and `templates:write`
(templates) are all **viewer+** — harnesses are collaborative eval content like datasets and judges, not
admin-gated infra. Isolation is still per workspace; credentials stay behind `secrets:write`.
`harnesses:delete` (version soft-delete) is admin with a creator exception in the service.

## Surface — BFF↔MCP parity

- **HTTP** (`apps/api/src/api/harness/`): `POST/GET /harness-templates`, `POST /harness-templates/validate`,
  `GET /harness-templates/:id`, `GET /harness-templates/:id/:version` (raw template);
  `POST/GET /harnesses` (instances), `POST /harnesses/validate`, `GET /harnesses/:id` (versions),
  `GET /harnesses/:id/:version` (the **resolved** spec), `GET /harnesses/:id/:version/instance` (raw instance),
  plus `diff`, `lineage`, `delegate`, version tags, soft delete and `POST /harnesses/:id/pins` (re-pin).
- **MCP**: `register_harness_template` / `list_harness_templates` / `get_harness_template` and
  `register_harness` / `list_harnesses` / `get_harness_instance` / `diff_harness_versions` /
  `get_harness_lineage` / `pin_harness_images` / `set_harness_version_tags` / `delete_harness`.
- **Web**: `/{ws}/harnesses` lists harnesses with variations grouped under their shape; `/{ws}/harness/[id]` is the
  detail (Config panel with the raw config, "new version", "new harness on this shape");
  `/{ws}/harness/[id]/new-version` and `/{ws}/harnesses/new` reuse the register-wizard forms
  (`InstanceForm`/`TemplateForm`) prefilled from the current config; `/{ws}/harness-templates` is the shape
  catalog. Versions are immutable, so editing = registering a new version: re-pinning makes a new instance tag,
  a structure change makes a new template version and returns to the instance tab (`?tplVersion=`).

## Scorecards / regression

Instances resolve to `id@version`, so scorecards and `diffScorecards` name exact instances. Two instances of
the same template (`bu@main` vs `bu@pr-123`) are an apples-to-apples regression where only pins/overrides differ.

## Image sources

A pin value stays a verbatim image reference; resolution never rewrites it. Pull credentials are attached at
dispatch from the workspace's registered registries and the managed image store (`docs/architecture/workspace-image-registry.md`,
`docs/architecture/managed-image-store.md`). A pin filled from a store environment carries a `pinSources`
annotation the web renders as a chip; `resolveHarnessInstance` ignores it.

---

# Instance variation — overrides beyond the image

Template = **shape**; instance = a delta that **does not change the shape**. A change belongs on the instance
when it yields a behaviorally different but structurally identical harness (same services, wiring, endpoints;
different knobs). It needs a new template version when it adds/removes a service or rewires (`needs`,
`dependencies`, `frontDoor.service`/`submit`, `traceSource.kind`, `target.kind`/`acquire`, ports).

## `overrides` (`InstanceOverridesSchema`)

```jsonc
// service instance — same template, a behavioral variation
{
  "template": { "id": "bu", "version": "2" },
  "id": "bu", "version": "main-opus-temp02",
  "pins": { "planner": "ghcr.io/acme/bu-planner:abc" },
  "overrides": {
    "services": { "planner": { "env": { "TEMPERATURE": "0.2" }, "model": "claude-opus-4-8" } },
    "frontDoor": { "request": { "bodyTemplate": { "max_steps": 30 } } }
  }
}
// command instance — CLI flags via {{var}} params + env
{
  "template": { "id": "aider", "version": "1" },
  "id": "aider", "version": "weak-model",
  "pins": { "model": "gpt-4o-mini" },
  "overrides": { "env": { "AIDER_TEMPERATURE": "0" }, "params": { "edit_format": "diff" } }
}
```

| Knob | Where | Merge |
|---|---|---|
| service `env` / `unsetEnv` | `overrides.services[name]` | env merged over the template's (instance wins), then `unsetEnv` drops keys; the runtime applies `connEnv < service.env < storeEnv` |
| service `replicas` / `resources` / `volumes` / `readiness` / `model` | `overrides.services[name]` | scalar replace |
| front-door body | `overrides.frontDoor.request.bodyTemplate` | shallow merge over the template's `bodyTemplate` |
| front-door completion timing | `overrides.frontDoor.completion.{timeoutMs,intervalMs}` | spread over the template's completion; keys the mode does not accept are dropped by the schema re-parse |
| browser extension | `overrides.target.extension.ref` | replace; `BadRequestError` if the template has no `target` |
| command `env` / `unsetEnv` / `params` | `overrides` | merged over the template's, then `unsetEnv`; `params` feed `{{key}}` substitution in `CommandHarness` (not shell-escaped — author-trusted; only `{{task}}` is quoted) |
| command `resources` | `overrides.resources` | scalar replace |
| command `prompt` | `overrides.prompt` | delivered through the template's `promptChannel` (see below) |

- **Unknown target** — a service name in `overrides.services` the template lacks → `BadRequestError`, the same
  discipline as image pins.
- **Command prompt** — `overrides.prompt` is an axis, not another env key (`evolution-program-gap-map.md` G4.9).
  The template declares the delivery (`promptChannel: { kind: "env", name }`); `resolveHarnessInstance` writes the
  text into that env key AND onto the resolved spec's `prompt` field from one value, so `specDigest` seals it and
  `diffHarnessSpecs` reports `prompt`. Refused: a `prompt` override with no declared channel, and a `prompt`
  override beside a hand-written `env` entry for the same key.
- **`resources` is a scalar REPLACE**, so an editor that emits only the changed half silently unsets the other;
  the web form re-states the inherited half whenever either changes.

## Runtime support (nomad · k8s · docker self-hosted)

| Knob | nomad | k8s | docker |
|---|---|---|---|
| `image`, service `env`, front-door request/completion, model | ✅ | ✅ | ✅ |
| `replicas` | `Count` | `replicas` | single host = 1 |
| `resources` (`cpu` 1000 = 1 vCPU, `memoryMb`) | `Resources.CPU/MemoryMB` (default 1000/1024) | `resources.requests=limits` | `--cpus` / `--memory` |
| `volumes` | docker driver `Config.volumes` | named → `emptyDir`, bind → `hostPath` | `-v` |
| `readiness` | per-endpoint HTTP wait | `readinessProbe` (httpGet `/`) | readiness poll |

Front-door and model knobs are runtime-agnostic (interpreted by the `FrontDoorDriver` / `ModelResolvingDispatcher`,
not the orchestrator). Overrides are baked into the resolved `id@version`, so warm pools key correctly and never
mix variants (the same mechanism `applyImagePins` uses, `-pin-<hash>`).

## The instance form edits EFFECTIVE config

A delta editor cannot be operated without seeing the effective value. The web seeds the form with a **baseline**
derived from the template (`baselineFromTemplate` → `OverrideBaseline`), renders inherited values with an
`inherited`/`overridden` badge, and `buildOverrides(state, baseline)` **diffs** — only what differs from the
template is stored.

- Per-service rows come from the template's service list; the name is not typed.
- An inherited env key cannot be deleted in place (overrides merge); deleting a row means `unsetEnv`, and the
  prefill drops an unset key again so it does not reappear on the next edit.
- With no baseline (`EMPTY_BASELINE`, the free-form path) every entered value is a delta.
- The template is **picked**, not typed: `?template=&tplVersion=` on `/{ws}/harnesses/new` carries the choice and
  the server builds that template's baseline.

## "Which harness is this?" is answered by the delta

`summarizeInstanceVariation` (`@everdict/domain`) projects an instance's delta into display chips
(`model=claude-opus-4-8` · `−OPENAI_BASE_URL` · `cpu 4000`), carried on `HarnessListEntry.variation`. The delta is
what the resolver applies, so it cannot drift the way prose does. A pin equal to the template default is dropped;
a secret-backed env shows the secret NAME.

## The shape catalog

`/{ws}/harness-templates` lists shapes — kind · category · service count · versions · which harnesses ride each ·
"new harness on this shape". It shows shapes nothing rides yet and answers "what shapes do we have" without the
harness list mixed in. `HarnessTemplateListEntry` carries `latestVersion`/`kind`/`category`/`serviceCount`
(derived in `enrichTemplateList`); the rider count is a join of two reads the page already makes.
