# Harness taxonomy — Template (대분류) + Instance (design)

> **Status: design / not yet implemented.** Track A of the harness rework. Track B (image-source
> integrations: GHCR / generic Docker / artifact registry) is a separate, later effort — see the end.
>
> **Clean break — no backward compatibility.** The old flat full-`HarnessSpec` *registration* path is removed
> outright; every harness is authored as Template + Instance. The resolved `HarnessSpec` survives only as the
> internal dispatch artifact produced by `resolve()`, never as a registration input. Existing examples/tests are
> converted in the same change set; there is no dual path and no migration of old flat entries.

## Problem

Today a harness is a single self-contained `HarnessSpec` keyed `(tenant, id, version)` in `@assay/registry`.
There is **no concept of a family/template**: a browser-agent topology and "the same topology with one service
bumped for PR #123 / sha abc" are two *unrelated, flat* harness entries. CI that registers a harness per PR/SHA
produces an explosion of look-alike entries, and the web lists each as an independent harness — impossible to
grasp which belong together or how they differ.

## Model — two authoring concepts, one resolved spec

We split *authoring* into two levels but keep the *resolved* artifact (what backends consume) unchanged.

```
Template (대분류)            "the shape"          versions unpinned, declares slots
   └── Instance (harness)   "shape + pins"       pins each slot to a concrete version/image
            └── resolve()  →  HarnessSpec (existing process|service|command)  →  dispatch
```

- **Template (대분류)** — the structural skeleton: for a topology, *which* services + dependencies + target +
  frontDoor + traceSource are involved, **without** image versions. Each versionable thing is a named **slot**.
  Example `bu` (browser-agent): services `{planner, browser, action-stream}` + dep `{redis}`, each service a
  slot. A template is itself **versioned** — changing the *shape* (add/remove a service, change wiring) is a new
  template version (e.g. `bu` structure `v1` → `v2`). Pinning a service version is **not** a template change.
- **Instance (개별 하네스)** — a template reference + **pins** (the delta): the concrete image/version for each
  slot. Typically one per PR/SHA, created by CI. Stored as pins only, never a full copy of the structure.
- **Resolved `HarnessSpec`** — `template structure (at the referenced template version) + pins`. This is the
  existing `process | service | command` spec the backends/runtime already consume. **Nothing downstream of
  resolution changes** — `AgentJob.harness:{id,version}` still names a concrete, runnable thing.

## Schemas (`@assay/core`)

New authoring schemas. The existing `HarnessSpecSchema` (`process|service|command`) is **demoted to the resolved
form only** — produced by `resolve()`, consumed by backends/runtime, and no longer accepted as a registration
input.

```jsonc
// Template (대분류) — structure once, slots instead of versions. Versioned by SHAPE.
{
  "category": "topology",            // 대분류 type label (topology|claude-code|codex|command|os-use-app|custom)
  "kind": "service",                 // which resolved kind it compiles to
  "id": "bu", "version": "1",        // template id + STRUCTURE version
  "services": [
    { "name": "planner",       "slot": "planner",       "needs": [] },
    { "name": "browser",       "slot": "browser" },
    { "name": "action-stream", "slot": "action-stream", "needs": ["redis"] }
  ],
  "dependencies": [{ "store": "redis", "role": "bus", "isolateBy": "key-prefix" }],
  "frontDoor": { "service": "planner", "submit": "/run" },
  "traceSource": { "kind": "otel", "endpoint": "..." }
}

// Instance (개별 하네스) — template ref + pins (delta only). One per PR/SHA.
{
  "template": { "id": "bu", "version": "1" },
  "id": "bu", "version": "pr-123-sha-abc",
  "pins": {
    "planner":       "ghcr.io/acme/bu-planner:abc123",
    "browser":       "chromedp/headless-shell:119",
    "action-stream": "ghcr.io/acme/bu-action:abc123"
  }
}
// resolve(bu@pr-123-sha-abc) = template bu@1 structure, each service.image := pins[slot]  →  ServiceHarnessSpec
```

For `command`/`process` templates the slots are the versionable params (image, `model`, a skills/workflow set);
the same template+pins → resolved `CommandHarnessSpec`/`ProcessHarnessSpec`. Topology is the driving case.

## Registry & resolution (`@assay/registry`)

- **Template registry**: `(tenant, templateId, templateVersion) → TemplateSpec`. Immutable versions (re-register
  different shape → `ConflictError`), tenant-owned + `_shared` fallback — identical discipline to harnesses today.
- **Instance** lives in the existing harness registry keyed `(tenant, id, version)` where `id` = the template id
  and `version` = the instance tag (`pr-123-sha-abc`, or semver). It stores `{template:{id,version}, pins}`.
- **`get(tenant, id, ref)`** resolves: load instance → load `template@instance.template.version` → merge
  structure + pins → validate against `HarnessSpecSchema` → return the resolved spec. `latest` on the id = latest
  instance (semver, else last-registered — unchanged).
- **No legacy path.** `register()` accepts a template or an instance — never a raw full `HarnessSpec`. The
  `_shared` example harnesses (`examples/harnesses/bu-1.0.0.json` etc.), `loadHarnessDir`, `RunService`'s
  `resolveHarness`, `ServiceTopologyBackend.specFor`, and the In-memory/Pg registries are all converted to the
  template/instance shape in the same change set.

## Permissions (`@assay/auth`) — "그 대신 대분류" governance

| Action | Role | What |
|---|---|---|
| `templates:write` | **viewer+ (no gate)** | define/version a template **structure** (services/deps shape) |
| `harnesses:register` (instances) | **viewer+ (no gate)** | register an **instance** (pins) under a template — CI/users |
| `harnesses:read` | viewer | read |

**No role gate (권한 상관없이 동등 사용).** Harnesses — both templates (대분류) and instances — are collaborative
eval content (like datasets/judges), not admin-gated infra. Every workspace member uses them equally: anyone can
define a template and register instances; reads are open. (This matches `harnesses:register` already being
viewer+ in `authz.ts`; `templates:write` joins it.) Isolation is still per-workspace — `templates:write` only
shapes harness *structure*, never credentials (those stay `secrets:write` = admin).

## Surface — BFF↔MCP parity

One service core, three transports (HTTP route + MCP tool + web), per the parity rule.

- **API/MCP**: `POST/GET /harness-templates` (admin write) + `POST/GET /harnesses` now = instances
  (member write, body = `{template, pins}`); validate (dry-run) mirrors. `GET /harnesses` returns instances
  **grouped by template** with the resolved diff. MCP: `register_template`/`list_templates` +
  `register_harness`(instance)/`list_harnesses`.
- **Web** (fixes the flat-explosion pain directly):
  - `/dashboard/harnesses` — top level lists **templates (대분류)** as cards: category, name, # instances,
    latest instance. The per-PR/SHA entries are **collapsed under their template**, not flat.
  - `/dashboard/harnesses/[template]` — the structure (services/deps) shown **once** + a table of instances
    (version, **pin diff**, created at, who).
  - **인스턴스 등록** form (member): pick a template → fill the image/version per slot → register.
  - **템플릿 등록** form (admin): define structure + slots.

## Scorecards / regression

Instances still resolve to `id@version`, so scorecards and `diffScorecards` name exact instances unchanged. A
natural new comparison: two **instances of the same template** (e.g. `bu@main` vs `bu@pr-123`) = a clean,
apples-to-apples regression where only pinned versions differ.

## Relationship to Track B (image-source integrations)

A pin value is an image reference. Today that is a raw string. Track B lets a pin be **sourced from a workspace
image-source integration** (GHCR / generic Docker / internal artifact registry; GitHub = *reference* a prebuilt
image, not build-from-source) — credentials via `SecretStore` (name-not-value, like runtime `authSecret`),
injected as a k8s/nomad `imagePullSecret` at dispatch. The instance form's per-slot picker then chooses
`connection + coordinate` instead of a raw string. Track B is designed separately once Track A lands.

## Phasing

All Track A phases land together as the clean break (no dual path is ever shipped):

1. **Core**: `TemplateSpec` + instance schema; `resolve(template, pins) → HarnessSpec`; demote `HarnessSpecSchema`
   to resolved-only (remove it as a registration input).
2. **Registry**: template store (in-memory + Pg, migration) + instance resolution; **convert** `examples/harnesses`
   + `loadHarnessDir` + seeds to template/instance; delete the flat full-spec registration path.
3. **Auth**: `templates:write` (admin) vs instance `harnesses:register` (member).
4. **API + MCP**: template routes/tools + instance register (pins) + grouped list; update every caller
   (`RunService.resolveHarness`, `ServiceTopologyBackend.specFor`); parity tests.
5. **Web**: replace the register-harness wizard with template-grouped list + template detail (structure +
   instance table w/ pin diff) + the two forms.
6. (later) **Track B**: image-source integrations feeding the per-slot pin picker.

> Blast radius (single change set): `@assay/core` harness-spec, `@assay/registry` (in-memory + Pg + loaders +
> migration), `@assay/auth` authz matrix, `apps/api` (server + mcp + run-service), `apps/web` register-harness +
> harnesses pages, `examples/harnesses/*`, and the tests across all of them.

## Cutover map (current state → target) — surveyed Phase 1/2 done

Every consumer of the flat `HarnessRegistry` (returns/accepts a full `HarnessSpec`) falls into **two buckets**.
The in-memory + Pg `HarnessInstanceRegistry` (Phase 2) already exposes `get()/getService()` that return a
**resolved** `HarnessSpec`, so the read bucket is a **zero-signature drop-in**.

**Bucket A — read-only `.get()/.getService()` → swap the injected registry to `HarnessInstanceRegistry` (no code change at the call site):**
- `apps/api/src/run-service.ts` `resolveHarness(tenant,id,version)` — wired in `main.ts:165` to `registry.get`.
- `apps/api/src/scorecard-service.ts:127,431` — `this.deps.harnesses.get(...)` (`harnesses: HarnessRegistry`).
- `apps/api/src/topology-backend.ts` `ServiceTopologyBackend.specFor` — `deps.harnesses.get(...)` → must be `kind:service`.
- `apps/api/src/judge-runner.ts` — harness-judge resolution via the injected harness registry.
  (RuntimeDispatcher reaches topology via `buildTopologyBackend({harnesses})`.)

**Bucket B — write/list/validate surface → re-shaped (this is the real work + the auth change):**
- `apps/api/src/server.ts`: `POST /harnesses` (register a full spec, gate `harnesses:register`=admin) →
  becomes **instance** register (`{template,pins}`, gate `harnesses:register`=**member**); `POST /harnesses/validate`
  (`ownVersions`) → instance validate (template exists + pins resolve); `GET /harnesses` (`list`) → instances
  grouped by template; `GET /harnesses/:id` (`versions`) → instance versions. **NEW**: `POST/GET /harness-templates`
  (+ `/validate`), gate `templates:write`=admin.
- `apps/api/src/mcp.ts`: `register_harness`/`validate_harness`/`list_harnesses` → instance semantics; **NEW**
  `register_template`/`list_templates`. (BFF↔MCP parity — same service core.)

**Wiring (`apps/api/src/main.ts`):** replace the single `registry` with `templateRegistry` + `instanceRegistry`
(InMemory or Pg by `DATABASE_URL`); `seedSharedHarnesses` → `loadHarnessTaxonomyDir(examples/harnesses)`; pass
`instanceRegistry` to Bucket-A consumers, both to `buildServer`/MCP.

**Examples to convert** (`examples/harnesses/*`, flat → `*.template.json` + `*.instance.json`): `bu-1.0.0`,
`bu-1.1.0` (one `bu.template` + two instances), `aider-0.74.0`, `aider-litellm`, `desktop-osworld-agent`,
`desktop-ssh-agent`, `desktop-ssh-settings-agent`.

**Delete (clean break):** the flat `HarnessRegistry`/`InMemoryHarnessRegistry`/`PgHarnessRegistry` +
`loadHarnessDir` (+ their tests) once Bucket A is on the instance registry — nothing registers a raw `HarnessSpec`
anymore. Keep shared helpers (`asService`, `compareVersions`, `resolveRef`, `SHARED_TENANT`, `LATEST`).

**Collision note:** Bucket B + wiring + examples touch `apps/api/server.ts`/`mcp.ts`/`scorecard-service.ts`/
`main.ts` + `apps/web` harness pages + `packages/auth/authz.ts` — all in the **active concurrent-edit zone**
(member-management + metrics/models, which currently leaves the tree RED). Cutover is one atomic change set; run
it when that work has landed and the tree is green. Bucket A swaps are mechanical once the wiring flips.
