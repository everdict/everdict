# Environment image store — managed eval-environment images as store assets

> **Status:** E1–E4 SHIPPED + E5 (agent guidance) — see the slice list for the per-slice state and the
> deliberate v1 reductions. Direction confirmed with the maintainer (2026-07-27):
> managed images should be store assets "like the skill/tool store", not raw strings.
> Builds on `docs/architecture/capability-store.md` (the store substrate) and
> `docs/architecture/workspace-image-registry.md` (where image bytes live + pull auth).

## Why

The motivating scenario: several workspaces evaluate the same benchmark — say **OfficeQA** — whose
environment needs a non-trivial library/tool stack baked into an image. Today each workspace prepares
that environment by itself, because an image in Everdict is a **raw string with no identity**:

- `TopologyService.image`, instance `pins` (slot → ref), `CommandHarnessSpec.image`, `EvalCase.image`
  all hold bare refs like `officeqa-env:v3`. The workspace-image-registry work gave those refs
  **classification** (`classifyImageRef`: workspace/external/local/unqualified) and **pull auth**, but
  nothing records *what the image is*: what's installed in it, what benchmark it serves, how a topology
  should wire it, who published it, or which version supersedes which.
- There is no place to **browse** available environment images, and no way to **share** one across
  workspaces — the only cross-tenant sharing anywhere is the operator-seeded `_shared` registry
  fallback and the capability store's `subset`/`public` tiers.
- An **agent that composes a topology** (the conversational agent already holds `register_harness` /
  `register_harness_template` in `EVAL_ACTIONS`) has no context source describing available
  environments — a human side-channels the image ref and its wiring conventions into the prompt.

So three requirements, one entity:

1. **Managed** — an environment image is a published, versioned asset with metadata visible in the
   store by default (what it contains, which benchmark, which registry it lives in).
2. **Shared** — one workspace builds + publishes the OfficeQA environment; other workspaces consume it
   instead of re-preparing it (`subset`/`public` reach).
3. **Composable-by-agents** — the asset carries a *hardcoded preset* (structured wiring fragment) and
   *instructions* (prose: how the environment is composed) so a topology-composing agent receives real
   context, not a bare ref.

## Decision — a new Capability kind: `environment`

The store substrate already exists and was explicitly designed for this move:
`docs/architecture/capability-store.md` locks "a future capability kind = a new `type` variant + an
adapter, with **zero** new table/store/route/authz-action." We take that offer.

- **`CapabilityType` gains `"environment"`** — a fourth variant beside `mcp | code | skill` on the one
  discriminated `Capability` entity. The `everdict_capabilities.type` column is unconstrained `text`
  (migration `0072`), so **no DB migration** — only the Zod enum, the spec union, and the web's loose
  mirror (`apps/web/src/entities/capability/model/schema.ts`) change.
- Everything the requirements need comes free from the substrate: immutable versions, the four reach
  tiers (`private | workspace | subset | public`) with the pure `canConsumeCapability` kernel,
  browse/publish web + MCP surfaces, `capabilities:*` authz, and the `_everdict` first-party tier for
  seeding common benchmark environments.

### Alternatives considered (and why not)

- **A new registry entity (`EnvironmentRegistry` in `@everdict/registry`)** — matches the
  harness/dataset/judge/runtime idiom, but its only sharing model is the operator-seeded `_shared`
  fallback. User-driven cross-workspace publishing is *the* point of this feature; grafting the
  visibility kernel + a second browse surface onto a registry entity would rebuild the capability
  store beside itself.
- **Stretching harness templates** — a template is the shape of a *whole topology* (services without
  images + slots), tenant-owned. An environment is a *per-image* asset that feeds pins across many
  templates and many workspaces. Different granularity, different sharing needs; see the taxonomy
  section below for how they compose instead.
- **`WorkspaceSettings` (like `imageRegistries[]`)** — settings are unversioned admin config, wrong
  for immutable, shareable, browsable assets.

The semantic stretch is acknowledged: an `environment` is not an *agent tool*. But neither is a
`skill` a tool — the store is already "assets an agent (or a member) draws on", and an environment is
exactly that for the topology-composing act. The store's framing softens from "agent capabilities" to
"capabilities + environments under one store surface"; the substrate is unchanged.

## The model

Additions to `packages/contracts/src/records/capability.ts` (reusing harness-spec schemas — the same
intra-package import `harness-template.ts` already does):

```ts
// The wiring dowry an image brings along: how a topology composes around THIS image. Every field is a
// suggestion consumed at AUTHORING time (web form prefill / agent context) — never silently applied at
// dispatch. Reuses the topology vocabulary verbatim so a preset is copy-paste-valid in a HarnessSpec.
export const EnvironmentPresetSchema = z
  .object({
    // Suggested service fragment for using this image as a topology service: port, env defaults,
    // readiness, resources, wiring (BYO env names), needs. No image (it IS this asset), no name
    // (the adopting template names the service).
    service: TopologyServiceSchema.omit({ image: true, name: true }).partial().optional(),
    // Stores this environment expects (postgres/redis/minio + isolateBy + inject templates).
    dependencies: z.array(TopologyDependencySchema).default([]),
    // Present when the image is a front-door service (how to submit/complete against it).
    frontDoor: FrontDoorSpecSchema.optional(),
    // Present when the environment expects a browser/OS target.
    target: TopologyTargetSchema.optional(),
  })
  .strict();

export const EnvironmentSpecSchema = z.object({
  type: z.literal("environment"),
  image: z.string().min(1), // fully-qualified pullable ref; digest-pinned recommended (mutable tag → publish warning)
  contents: z
    .object({
      benchmark: z.string().optional(), // e.g. "officeqa" — the benchmark this environment serves
      packages: z.array(z.string()).default([]), // headline libraries/tools baked in (discovery, not a manifest)
      os: z.string().optional(), // "linux" | "windows" | … (informs placement expectations)
      arch: z.string().optional(), // "amd64" | "arm64" | …
    })
    .optional(),
  preset: EnvironmentPresetSchema.optional(),
  // Markdown: how the environment is composed — entry points, conventions, seeded data, gotchas.
  // This is the context a topology-composing agent receives; written for a reader who will wire it.
  instructions: z.string(),
});
```

`CapabilityRecord.name` = the environment's display/reference name (e.g. `officeqa-env`); for this
kind no runtime tool is derived from it. `tags` carry free discovery facets as usual. No
`requiredSecrets` — pull auth is a *registry* concern resolved per consumer workspace (below), never
per asset.

### Taxonomy — environment vs template vs instance

Three legs, each already load-bearing except the first:

| Entity | Answers | Granularity | Sharing |
|---|---|---|---|
| **Environment** (store, NEW) | *what does this image provide, and how does one wire it?* | one image | 4-tier store reach |
| **HarnessTemplate** | *what is the shape of this topology?* (services minus images, slots) | whole topology | tenant + `_shared` |
| **HarnessInstance** | *which concrete images fill the slots?* (pins) | one deployment | tenant |

An environment's `preset` is the **dowry a pin brings along**: when a template slot (or a direct
`services[].image` / command `image` field) is filled from the store, the preset prefills the wiring
the author would otherwise hand-type — env defaults, dependencies, front-door shape. It seeds
authoring; it never mutates a template behind the author's back. A *multi-service* environment is not
one asset — it is a harness **template** whose slots are pinned from store environments (each image
one asset). That keeps each concept single-granularity.

## Consumption

### 1. Store browse (web + MCP)

The store page gains the `environment` kind filter; the card/detail shows: image ref + **per-consumer
classification badge** (`classifyImageRef` against *the viewer's* workspace registries — the same ref
can classify `workspace` for the publisher and `external` for a consumer), `contents` summary, preset
viewer (structured), `instructions` rendered, versions, publisher, reach. MCP parity through the
existing capability tools (`list/get_capability`) — agents browse the same catalog.

### 2. Harness authoring (web)

Every image input — instance **pins**, service-kind `services[].image`, command `image` — gains a
"from store" picker listing visible environments (with pull-readiness hint). Picking one:

- inserts the **verbatim ref** (`spec.image`) — refs stay strings; the locked no-rewrite invariant of
  `workspace-image-registry.md` holds;
- prefills the wiring from `preset` where the form has matching fields (service env/port/readiness,
  dependencies, front door) — visible, editable, nothing hidden;
- (optional slice) records provenance as an **annotation**: `HarnessInstanceSpec.pinSources?:
  Record<slot, {source, id, version}>` — ignored by `resolveHarnessInstance`, used only for badges and
  "newer environment version available" hints. Absent = today's behavior, so existing specs are
  untouched.

### 3. Agent composition (the third requirement)

The conversational agent already holds the authoring verbs (`EVAL_ACTIONS`:
`register_harness_template`, `register_harness`, `pin_harness_images`). What it lacks is environment
context; with environments in the store it arrives through the **existing** capability read tools:

> "OfficeQA 토폴로지 만들어줘" → agent lists visible `environment` capabilities → reads
> `contents`/`preset`/`instructions` of `officeqa-env` → composes the template/instance (preset
> fragments pasted into the spec, image ref pinned) → registers via `EVAL_ACTIONS`.

Slice E5 adds the prompt-level guidance (agent instructions/skill: *when composing a topology, check
the store for a matching environment first and honor its preset + instructions*) — no new runtime
adapter is required, which is exactly the store-substrate payoff. Environments do **not** join the
first-party *default toolset* mechanism (they are not tools and have no default-enabled semantics);
`_everdict` may still publish them `public` as first-party seeds.

### 4. Cross-workspace pullability — honest v1 stance

Sharing the *asset* does not by itself make the *bytes* pullable: pull secrets are workspace-scoped
(`imageRegistries[].pullSecretName`). v1 keeps the boundary explicit rather than brokering credentials:

- A shareable environment should reference a registry its consumers can pull: a public registry, or a
  common BYO registry that each consuming workspace registers **with its own pull secret** (the
  publisher's setup guidance belongs in `instructions`).
- The store detail surfaces per-consumer pull readiness: class `workspace`/`external` → pullable
  (given that workspace's auth); `local`/`unqualified` → warned at publish time (reusing the domain
  `imageWarnings` rules, including the mutable-tag warning) *and* badged for consumers. Warn, never
  block — the same stance as harness registration.
- **Cross-tenant pull-credential brokering** (store-mediated minting of pull auth for consumers of a
  shared environment) is a named later option, not v1: it creates a real trust surface (publisher
  credentials exercised by foreign workspaces) that deserves its own design.

## Authz

Reused verbatim: `capabilities:read` (browse/resolve), `capabilities:write` (publish a version;
`public` reach stays admin-gated), `capabilities:delete` (creator-or-admin). No new actions.

## Slices

- **E0 — this doc.** ✅
- **E1 — contracts + store** ✅: `EnvironmentImageSpecSchema` + `EnvironmentPresetSchema` +
  `EnvironmentContentsSchema` (`packages/contracts/src/records/capability.ts`, reusing the topology
  schemas verbatim; the preset `service` fragment is strict so an accidental `image`/`name` key is
  rejected, not stripped); `CapabilityType` gains `"environment"`. No DB migration (`0072`'s `type`
  column is unconstrained text). Tests: contracts schema suite + db store round-trip.
- **E1b — publish-time warnings + browse classification** ✅ (service-level, so both transports get
  parity free): `CapabilityService` takes `registryCoordinates`; `save` attaches `imageWarnings`
  (warn-not-block, every path incl. the idempotent no-op), and reads (`list`/`listPublic`/`get`)
  annotate environment records with the **viewer-relative** `imageClass` (`CapabilityView`) — the
  server-side classification pattern (the web's client-side classify mirror is deleted; P1g).
- **E2 — API/MCP pass-through** ✅: union flows through routes + MCP; `listPublic` takes the viewer
  workspace; routes test covers save/warn/strict-preset-400/read-back+`imageClass`.
- **E3 — web store surface** ✅: kind filter + environment card (image ref + viewer-relative class
  badge + benchmark/OS chips) + author form (image, contents fields, preset as raw JSON [the
  overrides-JSON-textarea precedent — a structured preset builder is a later nicety], instructions)
  + publish-warning toasts; mirror schema types anchored to the contracts (`EnvironmentPreset` via
  `import type` + shallow runtime check — the traceEvent-passthrough precedent).
- **E4 — harness-authoring consumption** ✅: "from store" picker (`EnvironmentPicker`) on instance
  **pins** (fixed + free variants) and the command-form image field, inserting the verbatim ref; the
  template **service rows** get a preset-prefill picker (`applyEnvironmentPreset` — fills
  port/needs/perRun/env/wiring/readiness/os and appends missing preset dependencies with management
  reverse-derived from `isolateBy`).
- **E4b — pin provenance** ✅: `HarnessInstanceSpec.pinSources` (slot → `{source,id,version}`) — a
  pure ANNOTATION: `resolveHarnessInstance` ignores it (the pin value stays the verbatim ref), the
  wizard records it on pick and clears it on hand-edit (the annotation never lies), the harness
  detail config panel renders a "Store: id@version" chip. Store→pin flow is covered end-to-end at
  the HTTP layer (publish → consumer read → template + pinned instance → raw round-trip + resolved
  spec annotation-free). Deferred: the "newer environment version available" hint.
- **E4c — store card drill-in** ✅: the environment card expands in place (single-open) to the
  rendered instructions + preset JSON + package chips.
- **E6 — the authoring journey is one path** ✅ (the "can an agent do this end-to-end?" review): the
  bytes and the asset stop being two disconnected acts. `everdict image push --register-environment <id>`
  registers the pushed ref (digest-pinned from docker's `RepoDigests`, os/arch read off the local image,
  reach defaulting to `workspace`) right after the push; the plugin skill + the conversational agent's
  system prompt carry the build→push→register→pin recipe (before this, both only described CONSUMING an
  environment, so the authoring half was invisible to agents); `verify_image` / `…/verify` bring the
  adoption-grade pull check to authoring time with a digest-pin action; and Settings › Environments gets
  the same conversation entry point the other entity surfaces have (`environment` is an agent reference
  type, so a row can be handed to the agent as context). Two open questions close with it (digest pinning,
  `EvalCase.image` consumption) and the first-version reach default becomes kind-dependent, so registering
  through the API/MCP no longer creates a team asset only its author can see.
- **E5 — agent guidance** ✅ prompt-level: the agent system prompt directs compose-from-store (browse
  `environment` capabilities → pin the ref verbatim → honor preset/instructions); the store read
  tools were already in the agent's read-only allowlist. **Pending:** the live end-to-end scenario
  (agent composes an OfficeQA-style topology from a seeded `_everdict` environment).

## Non-goals

- **Building images** — Everdict never runs `docker build`; the bytes come from the author's own build.
  `everdict image push` remains the publish path (its `--register-environment <id>` flag registers the pushed
  ref as an environment in the same step).
  - ~~**Hosting images**~~ — **CLOSED by `docs/architecture/managed-image-store.md`.** This file was written
    when every environment image had to live in a registry the workspace ran itself, which made "adopt a
    published environment" mean "and also go get pull access to a stranger's registry". Everdict now hosts a
    registry of its own: a published environment's image can live in the publisher's managed namespace, and a
    consumer that adopts it gets a short-lived pull grant we mint (M6) instead of a credential exchange we
    cannot broker. Hosting is no longer a non-goal — only building is.
- **Rewriting refs at dispatch** — specs keep verbatim strings; the store informs authoring only.
- **Cross-tenant pull-credential brokering** — later option (see above).
- **Multi-service environment bundles** — that is a harness template; one environment = one image.
- **A parallel "image catalog" outside the store** — the capability entity is the one catalog.

## Open questions

- ~~**Digest pinning UX**~~ — ANSWERED (E6): the registry call exists, so the author gets both halves.
  `GET /workspace/image-registries/verify?image=` (+ MCP `verify_image`) runs the SAME active pull check
  environment ADOPTION runs (`ImageRegistryService.verifyImage`), closing the asymmetry where a publisher's
  own just-pushed image got only a static classification warning while someone else's import got a real
  check. The editor's "Verify pull" renders `pullable`/`reason` and, on success, offers a one-click **pin
  this digest**; changing the ref discards the verdict so a stale badge can never lie. On the CLI path
  `everdict image push --register-environment` digest-pins from docker's own `RepoDigests`.
- **Preset drift** — when a new environment version changes the preset, already-authored harnesses
  keep their copied wiring (by design). Is a diff hint ("your harness wiring differs from the pinned
  environment's current preset") worth building, or noise?
- ~~**`EvalCase.image` consumption**~~ — ANSWERED (E6): yes, the same picker. `EnvironmentPicker` moved out of
  `features/register-harness` into its own `features/pick-environment` slice (the `pick-secret` precedent — a shared
  picker belongs to no single authoring surface), and the dataset form uses it. Because a case's `image` is the
  container THAT case runs in and a benchmark bundle almost always runs one environment, picking applies the ref to
  **every** case (parse → set `image` → re-serialize) rather than inserting text at the caret, which would break the
  JSON as often as not. Prebuilt public images stay perfectly authorable by hand — the picker adds a path, not a gate.
- **Store naming** — with a non-tool kind aboard, does the web surface rename from "capabilities" to
  just "Store"? (Cosmetic; the entity name stays.)
