# Harness taxonomy — Template (category) + Instance (design)

> **Status: design / not yet implemented.** Track A of the harness rework. Track B (image-source
> integrations: GHCR / generic Docker / artifact registry) is a separate, later effort — see the end.
>
> **Clean break — no backward compatibility.** The old flat full-`HarnessSpec` *registration* path is removed
> outright; every harness is authored as Template + Instance. The resolved `HarnessSpec` survives only as the
> internal dispatch artifact produced by `resolve()`, never as a registration input. Existing examples/tests are
> converted in the same change set; there is no dual path and no migration of old flat entries.

## Problem

Today a harness is a single self-contained `HarnessSpec` keyed `(tenant, id, version)` in `@everdict/registry`.
There is **no concept of a family/template**: a browser-agent topology and "the same topology with one service
bumped for PR #123 / sha abc" are two *unrelated, flat* harness entries. CI that registers a harness per PR/SHA
produces an explosion of look-alike entries, and the web lists each as an independent harness — impossible to
grasp which belong together or how they differ.

## Model — two authoring concepts, one resolved spec

We split *authoring* into two levels but keep the *resolved* artifact (what backends consume) unchanged.

```
Template (category)         "the shape"          versions unpinned, declares slots
   └── Instance (harness)   "shape + pins"       pins each slot to a concrete version/image
            └── resolve()  →  HarnessSpec (existing process|service|command)  →  dispatch
```

- **Template (category)** — the structural skeleton: for a topology, *which* services + dependencies + target +
  frontDoor + traceSource are involved, **without** image versions. Each versionable thing is a named **slot**.
  Example `bu` (browser-agent): services `{planner, browser, action-stream}` + dep `{redis}`, each service a
  slot. A template is itself **versioned** — changing the *shape* (add/remove a service, change wiring) is a new
  template version (e.g. `bu` structure `v1` → `v2`). Pinning a service version is **not** a template change.
- **Instance (individual harness)** — a template reference + **pins** (the delta): the concrete image/version for each
  slot. Typically one per PR/SHA, created by CI. Stored as pins only, never a full copy of the structure. May
  carry an optional free-text **`description`** — this version's changelog note ("what changed"), entered when
  deploying a new version and shown on the harness detail. It is part of the version's immutable content
  (`specsEqual`), but runtime-irrelevant so `resolve()` does not carry it into the resolved `HarnessSpec`.
- **Resolved `HarnessSpec`** — `template structure (at the referenced template version) + pins`. This is the
  existing `process | service | command` spec the backends/runtime already consume. **Nothing downstream of
  resolution changes** — `CaseJob.harness:{id,version}` still names a concrete, runnable thing.

## Schemas (`@everdict/contracts`)

New authoring schemas. The existing `HarnessSpecSchema` (`process|service|command`) is **demoted to the resolved
form only** — produced by `resolve()`, consumed by backends/runtime, and no longer accepted as a registration
input.

```jsonc
// Template (category) — structure once, slots instead of versions. Versioned by SHAPE.
{
  "category": "topology",            // category type label (topology|claude-code|codex|command|os-use-app|custom)
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

// Instance (individual harness) — template ref + pins (delta only). One per PR/SHA.
{
  "template": { "id": "bu", "version": "1" },
  "id": "bu", "version": "pr-123-sha-abc",
  "description": "planner prompt rework + bump browser to 119", // optional — this version's changelog (shown on detail)
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

## Registry & resolution (`@everdict/registry`)

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

## Permissions (`@everdict/auth`) — "category, not role" governance

| Action | Role | What |
|---|---|---|
| `templates:write` | **viewer+ (no gate)** | define/version a template **structure** (services/deps shape) |
| `harnesses:register` (instances) | **viewer+ (no gate)** | register an **instance** (pins) under a template — CI/users |
| `harnesses:read` | viewer | read |

**No role gate (equal use regardless of role).** Harnesses — both templates (category) and instances — are collaborative
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
  - **Raw config reads** (pre-resolve originals): `GET /harness-templates/:id/:version` → `HarnessTemplateSpec`
    (structure/slots) and `GET /harnesses/:id/:version/instance` → `HarnessInstanceSpec` (template ref + pins).
    Distinct from `GET /harnesses/:id/:version` (the **resolved** spec). MCP parity:
    `get_harness_template` / `get_harness_instance` (`harnesses:read`). These power the web Config panel + the
    edit-and-new-version prefill below.
- **Web** (fixes the flat-explosion pain directly):
  - `/dashboard/harnesses` — top level lists **templates (category)** as cards: category, name, # instances,
    latest instance. The per-PR/SHA entries are **collapsed under their template**, not flat.
  - `/dashboard/harnesses/[template]` — the structure (services/deps) shown **once** + a table of instances
    (version, **pin diff**, created at, who).
  - **Instance registration** form (member): pick a template → fill the image/version per slot → register.
  - **Template registration** form (admin): define structure + slots.
  - **Harness detail → Config panel + Create new version**: the detail page shows the active version's raw config
    (template ref + slot→value pins) and a "Create new version" entry. Because versions are **immutable**, editing =
    registering a new version: the register-wizard forms (`InstanceForm`/`TemplateForm`) are reused **prefilled**
    from the current config (`instanceStateFromSpec` / `templateStateFromSpec`), with `id`/`kind` locked. Two axes:
    re-pin instance pins → new instance tag (→ detail of the new version); template structure change → new template semver,
    then the page returns to the instance tab (`?tplVersion=`) to re-pin an instance on the new structure.

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

> Blast radius (single change set): `@everdict/contracts` harness-spec, `@everdict/registry` (in-memory + Pg + loaders +
> migration), `@everdict/auth` authz matrix, `apps/api` (server + mcp + run-service), `apps/web` register-harness +
> harnesses pages, `examples/harnesses/*`, and the tests across all of them.

## Cutover map (current state → target) — surveyed Phase 1/2 done

Every consumer of the flat `HarnessRegistry` (returns/accepts a full `HarnessSpec`) falls into **two buckets**.
The in-memory + Pg `HarnessInstanceRegistry` (Phase 2) already exposes `get()/getService()` that return a
**resolved** `HarnessSpec`, so the read bucket is a **zero-signature drop-in**.

**Bucket A — read-only `.get()/.getService()` → swap the injected registry to `HarnessInstanceRegistry` (no code change at the call site):**
- `apps/api/src/execution/run-service.ts` `resolveHarness(tenant,id,version)` — wired in `main.ts:165` to `registry.get`.
- `apps/api/src/execution/scorecard-service.ts:127,431` — `this.deps.harnesses.get(...)` (`harnesses: HarnessRegistry`).
- `apps/api/src/execution/topology-backend.ts` `ServiceTopologyBackend.specFor` — `deps.harnesses.get(...)` → must be `kind:service`.
- `apps/api/src/execution/judge-runner.ts` — harness-judge resolution via the injected harness registry.
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
(member-management + models, which currently leaves the tree RED). Cutover is one atomic change set; run
it when that work has landed and the tree is green. Bucket A swaps are mechanical once the wiring flips.

---

# Instance variation — richer overrides (beyond image)

> **Status: design + Phases 1–3 implemented (web/MCP UI is the remaining follow-up).** Track A landed
> templates/instances, but an instance can pin only the
> **image** per slot (and `image`/`model` for command). That is too thin to express a *variation* of the same
> template — same shape, different behavior (model, sampling temperature, feature flags, CLI flags, submit-payload
> knobs, replicas, resources). Today every such variation forces a **new template version**, even though the shape
> is unchanged → template proliferation, or everyone is stuck on identical non-image config.

## Problem

`HarnessInstanceSpec.pins` is a **`Record<string, string>`** — slot → image (service), or `image`/`model`
(command). The value is a bare string, so even conceptually a pin cannot carry a structured delta (an env map, a
number, a nested body field). `resolveHarnessInstance` therefore copies *everything else* (`env`, `replicas`,
`volumes`, `readiness`, `dependencies`, `frontDoor`, `target`, `traceSource`; command `setup`/`command`/`env`/
`trace`) verbatim from the template. The only instance axis is "swap the image."

## Principle — what is an instance delta vs a template change

Template = **shape**; instance = a delta that **does not change the shape**. A change is instance-appropriate
when it yields a *behaviorally different but structurally identical* harness — same services, same wiring, same
endpoints; different knobs. It is template-appropriate when it adds/removes a service or rewires (`needs`,
`dependencies`, `frontDoor.service`/`submit`, `traceSource.kind`, `target.kind`/`acquire`, `port` topology).

## Runtime support is the gating fact (nomad · k8s · docker self-hosted)

What an instance can *meaningfully* vary depends on what the three runtimes honor. Surveyed from the runtime
builders:

| Knob | nomad | k8s | docker (self-hosted) | notes |
|---|---|---|---|---|
| `image` | ✅ | ✅ | ✅ | the only pin today |
| service `env` | ✅ | ✅ | ✅ | all three inject; precedence `connEnv < svc.env < storeEnv` |
| `replicas` | ✅ `Count` | ✅ `replicas` | ⚠️ single-host = 1 | |
| `resources` (cpu/mem) | ❌ hardcoded `1000/1024` | ❌ none | ❌ | **no knob anywhere — a gap** |
| `readiness` | ❌ | ❌ | ✅ | docker-only today |
| `volumes` | ❌ | ❌ (PVC later) | ✅ | docker-only today |
| front-door `request`/`completion`/`correlate` | ✅ | ✅ | ✅ | **runtime-agnostic** — the FrontDoorDriver/control plane interpret it, not the orchestrator |
| model (registry id) | ✅ | ✅ | ✅ | flows via env/body or command `{{model}}` → resolved by `ModelResolvingDispatcher` |

**Key insight:** the highest-leverage, most uniform knobs — service `env`, the front-door submit payload, model —
are **runtime-agnostic**, resolved purely at `resolve()` time (or by the driver), so they work identically on all
three runtimes with **zero runtime change**. `resources`/`replicas`/`volumes`/`readiness` are orchestrator-specific
and only partially supported, so they are later phases.

## Model — `pins` (images) + structured `overrides`

Keep `pins` (slot → image string) for the common case and back-compat. Add an optional, kind-aware
**`overrides`** object carrying structured deltas, deep-merged onto the template by `resolveHarnessInstance`.

```jsonc
// service instance — same template "bu@2", three behavioral variations differ only by overrides
{
  "template": { "id": "bu", "version": "2" },
  "id": "bu", "version": "main-opus-temp02",
  "pins": { "planner": "ghcr.io/acme/bu-planner:abc", "browser": "chromedp/headless-shell:119" },
  "overrides": {
    "services": { "planner": { "env": { "MODEL": "claude-opus-4-8", "TEMPERATURE": "0.2" } } },
    "frontDoor": { "request": { "bodyTemplate": { "max_steps": 30 } } }
  }
}
```
```jsonc
// command instance — same template, different CLI flags via {{var}} params + env
{
  "template": { "id": "aider", "version": "1" },
  "id": "aider", "version": "weak-model",
  "pins": { "model": "gpt-4o-mini" },
  "overrides": { "env": { "AIDER_TEMPERATURE": "0" }, "params": { "edit_format": "diff" } }
}
```

### Merge semantics (must be exact — env precedence matters across the 3 runtimes)

- **service env**: resolved `service.env = { ...template.service.env, ...overrides.services[name].env }` (instance
  wins). The runtime then applies its existing `connEnv < service.env < storeEnv` — i.e. instance env sits **above
  template defaults, below operational `storeEnv`** (cluster wiring stays authoritative for connection correctness).
- **front-door body**: shallow-merge `bodyTemplate` values over the template's (`{ ...template.bodyTemplate,
  ...overrides.bodyTemplate }`); the `FrontDoorDriver` already `{{var}}`-interpolates the result.
- **command env / params**: `env`/`params` each merge over the template's; `params` feed generic `{{key}}`
  substitution in `CommandHarness` (generalizing the reserved `{{task}}`/`{{model}}`/`{{run_id}}`). `params` values
  are **not** shell-escaped (author-trusted, like `{{model}}`); only `{{task}}` (the untrusted eval input) is.
- scalars added later (`replicas`/`resources`/`readiness`/`volumes`) = **replace**, not merge.
- **Unknown target** (a service name in `overrides.services` that the template lacks) → `BadRequestError`, the same
  discipline as image pins / `applyImagePins`.

### Warm-pool identity

Overrides are baked into the resolved `id@version` (the instance version tag), so warm pools key correctly and
never mix variants — the same mechanism `applyImagePins` uses (`-pin-<hash>`). No runtime change needed for
isolation.

## Phasing

- **Phase 1 — runtime-agnostic, `resolve()`-time only (implemented now):** per-service `env` overlay (service) +
  front-door `request.bodyTemplate` value override (service) + command `env` overlay + command `params` (`{{var}}`).
  Pure `@everdict/contracts` schema + `resolveHarnessInstance` merge + `CommandHarness` `{{var}}` substitution. Flows
  end-to-end through API/MCP immediately (they validate `HarnessInstanceSpecSchema`, which now accepts `overrides`).
- **Phase 2 — orchestrator knobs (implemented):** `resources { cpu, memoryMb }` added to `TopologyService` and
  honored by all three runtimes — nomad `Resources.CPU/MemoryMB` (replacing the hardcoded `1000/1024`), k8s
  container `resources.requests=limits` (`${cpu}m` / `${memoryMb}Mi`), docker `--cpus` (`cpu/1000`) / `--memory`
  (`${memoryMb}m`). `cpu` is `1000 = 1 vCPU` (k8s millicores convention). `resources` + the already-honored
  `replicas` are instance-overridable (`overrides.services[name].{resources,replicas}`, scalar replace).
- **Phase 3 — instance overrides + all-runtime volumes/readiness (implemented):**
  `overrides.services[name].{volumes,readiness}` (scalar replace) + `overrides.target.extension.ref` (browser
  extension pin; `BadRequest` if the template has no `target`) + `overrides.frontDoor.completion.{timeoutMs,
  intervalMs}` (spread onto the template's completion; mode-mismatched keys are stripped by the schema re-parse,
  so e.g. `intervalMs` is dropped on a non-`poll` completion). **All three runtimes now honor `volumes`/`readiness`
  (no longer docker-only):** k8s renders `volumes`+`volumeMounts` (named→`emptyDir`, bind→`hostPath`) and a
  `readinessProbe` (httpGet `/`, `periodSeconds`=interval, `failureThreshold`=⌈timeout/interval⌉); nomad sets the
  docker driver `Config.volumes` and threads `svc.readiness` into the runtime's per-endpoint HTTP wait; docker as
  before.
- **Web UI — structured override editors (implemented):** the instance register/new-version form has a collapsible
  "variations (overrides)" disclosure with per-service rows (env/replicas/resources/volumes/readiness), a front-door block
  (submit-body JSON + completion timeouts), a target-extension field, and command env/params — `buildOverrides`
  assembles the spec, `instanceStateFromSpec` round-trips existing overrides back into the fields for
  edit→new-version; the Config panel renders the resolved overrides. MCP/HTTP parity is automatic (schema-driven JSON).

> Blast radius: `@everdict/contracts` (`harness-spec` `params`/`ServiceResources`/`TopologyService.resources`,
> `harness-template` `overrides` + resolve), `@everdict/harnesses` (`CommandHarness` `{{var}}`), `@everdict/topology`
> (nomad/k8s/docker resources + volumes + readiness honoring), `apps/web` (structured override editor), + tests.
> No registry, auth, or API route changes (the instance JSON round-trips through the validated schema).
