# Capability Store (SSOT)

> A **store** — not a private registry — where a workspace's members AUTHOR agent capabilities (managed **tool
> adapters**, not raw MCP endpoints) and **publish** them at one of three reach tiers: **private** (only me),
> **subset** (a chosen subset of *your own* workspaces — "this skill, in 2 of my 5 workspaces"), or **public**
> (every Everdict workspace). One discriminated
> `Capability` entity carries three kinds — `mcp` (a curated MCP connection), `code` (a python/node tool Everdict
> executes), `skill` (instructions) — so a browsing member adopts a capability into their agent instead of hand-typing
> a server URL. Design confirmed with the user (2026-07-24): **ideal structure + flexibility prioritized over least
> disruption** → one unified versioned entity (mirrors the `Judge` kind idiom), adoption by **immutable-version
> reference** (not value copy), skills folded in. Doc-first.

## Problem

Today the only agent tool channel is `AgentSpec.mcpServers[]` (`packages/contracts/src/harness/agent-spec.ts`): a
member hand-types `{name, url, authSecret, write}` per server in **Settings › Agent**. That is:

- **Raw, not managed** — no adapter that already knows a tool's URL, which secrets it needs, and what it provides;
  every member re-discovers and re-types the same server.
- **Not discoverable** — a tool one member wires up is invisible to everyone else; nothing is browsable or reusable.
- **Not shareable** — there is no way to offer a tool to another workspace, let alone publish one broadly. The only
  cross-tenant sharing anywhere in Everdict is the first-party `_shared` registry fallback (operator-seeded, not
  user-authored).
- **MCP-only** — a "tool" can only be an external MCP server. A member cannot ship a small python/node function as a
  tool without standing up and hosting an MCP server.
- **Skills are a parallel, weaker channel** — `SkillRecord` (`packages/contracts/src/records/skill.ts`) is
  instructions-only, `private|workspace`, mutable, and **ambient** (every visible skill auto-applies via
  `skillStore.list`). It cannot be shared beyond a workspace and is not part of any store.

We want a **store**: managed, browsable, adoptable capabilities that members author and publish across three reach
tiers, spanning tools (MCP + code) and skills under one surface.

## Key insight: three layers, one entity

The feature splits cleanly into three layers, each landing on an existing pattern:

```
① CATALOG (the store)     Capability = the SSOT of what exists to adopt (browse · publish · version)
                          one entity, discriminated: type ∈ { mcp | code | skill }
                          reach: private | workspace | subset(sharedWith[]) | public
                          immutable versions (npm-style) + a pure visibility kernel in @everdict/domain
                                  │  browse / publish
                                  ▼
② ADOPTION (agent config) AgentSpec.capabilities[] = immutable-version REFERENCES to catalog entries
                          { source, id, version, … consumer-side binding } — a pinned, reproducible dependency
                          upgrade = re-pin to a newer version; the catalog stays the single source of truth
                                  │  resolve (cross-tenant, visibility re-checked, best-effort)
                                  ▼
③ RUNTIME (apps/agent)    profile.ts resolves each ref → splits by type → type-specific adapter:
                          • mcp   → existing mcpToolToDefinition bridge         (runtime unchanged)
                          • skill → existing use_skill tool                     (runtime unchanged)
                          • code  → NEW: provision a sandbox ComputeHandle, run the script, parse stdout → ToolResult
```

Two structural choices (confirmed, chosen for structure + flexibility over least disruption):

1. **One unified `everdict_capabilities` versioned table, discriminated by `type`** — not a `Tool` table plus a
   separate `Skill` table. This is exactly the idiom Everdict already uses for **Judges** (`model|harness|code` under
   one entity). A future capability kind = a new `type` variant + a runtime adapter, with **zero** new
   table/store/route/authz-action. Skills (nascent — migration `0071`) fold in as `type:'skill'`.
2. **Adoption by immutable-version reference, not value copy** — because versions are immutable (a published
   `x@1.2.0` never changes), a `{source, id, version}` reference is *already* a reproducible pin. The catalog is the
   only SSOT; `AgentSpec` stays thin; the store keeps live provenance ("N workspaces adopted this", "update
   available", deprecation). A pinned public `code` tool is as audit-safe as a value copy — its version cannot mutate
   under the adopter — while staying normalized.

The MCP runtime path does **not** change: an adopted `mcp` capability resolves to the same bridged tools the raw
`mcpServers[]` path already produces. The store is a curation/discovery/sharing layer *over* the existing bridge.

## The `Capability` model

The Zod schema is the SSOT (`packages/contracts/src/records/capability.ts`); types are `z.infer`red. The spec is a
discriminated union so each kind validates its own shape.

```ts
type CapabilityType = 'mcp' | 'code' | 'skill'

// Reach tier. Extends the `private | workspace` vocabulary (Views / skills / browser-profiles) with the two
// genuinely-new cross-tenant tiers. `workspace = tenant = trust-zone`.
type CapabilityVisibility =
  | 'private'    // creator-only, within the owning workspace
  | 'workspace'  // any member of the owning workspace
  | 'subset'     // the owning workspace + every workspace id in `sharedWith`
  | 'public'     // every Everdict workspace (cross-tenant read)

// --- the discriminated spec (spec.type is the record's kind) ---

interface McpToolSpec {           // a curated, managed MCP connection (the "adapter")
  type: 'mcp'
  // EXACTLY ONE transport (enforced at the save boundary — SaveCapabilityBodySchema — since a discriminatedUnion
  // member can't be a refined ZodEffects). url = a remote server; image = a container Everdict runs over stdio.
  url?: string                     // remote MCP endpoint (Streamable HTTP); auth = requiredSecrets[0] → Authorization
  image?: string                   // container image → `docker run --rm -i <image> [args]` (MCP over stdio); requiredSecrets → --env
  args?: string[]                  // trailing args after the image (stdio only) — e.g. ["-t","stdio"] for grafana/mcp-grafana
  provides?: string[]              // the tool names this server exposes (for the store card; discovery only)
  requiredSecrets: { name: string; description: string }[]  // secrets the ADOPTER must supply (declared, never valued)
  write: boolean                   // does this server offer mutating tools (adopter still opts in per-adoption)
}
// Containerized stdio servers are ISOLATED by construction (the container is the sandbox — matching the code-tool
// sandbox discipline and the Docker MCP Catalog distribution) and are OPERATOR-GATED: the agent spawns `docker run`
// only when AGENT_MCP_ALLOW_STDIO is set (default off), and — if AGENT_MCP_STDIO_ALLOWED_IMAGES pins a set — only for
// images on that allowlist; otherwise the capability is skipped (degrade, never fail). Curated
// image-transport servers are seeded in `firstPartyCatalogExtras()` (public + adoptable, NOT default-enabled) —
// e.g. the Grafana MCP server (grafana/mcp-grafana). Self-hosted stdio servers (ClickHouse, Playwright, Qdrant, …)
// are the reason for this transport: they have no universal HTTP endpoint, so `url` alone couldn't publish them.

interface CodeToolSpec {          // a python/node function Everdict runs and bridges as a callable tool
  type: 'code'
  language: 'python' | 'node'
  code: string                     // the source, pinned by version (immutable — auditable)
  parametersSchema: Record<string, unknown>  // JSON Schema for the tool's arguments (shown to the model verbatim)
  isReadOnly: boolean              // read-only tools skip the permission gate; writes require consent
  timeoutSec?: number
  image?: string                   // optional dedicated sandbox image (else the default hardened sandbox)
  requiredSecrets?: { name: string; description: string }[]  // env the adopter binds at adoption
  examples?: { name?: string; input: Record<string, unknown>; note?: string }[]  // worked examples (see below)
}

interface SkillSpec {             // the SKILL.md shape (today's SkillRecord), now versioned + shareable
  type: 'skill'
  instructions: string             // the SKILL.md body, loaded on demand via use_skill
  files: SkillFile[]               // supporting reference files, each loaded individually via read_skill_file
}

type CapabilitySpec = McpToolSpec | CodeToolSpec | SkillSpec

interface CapabilityRecord {
  id: string
  tenant: string                   // the OWNER workspace (the publisher)
  version: string                  // immutable; new content = new version (registration-order / semver, like harness/judge)
  name: string                     // the tool/skill name the agent sees (namespaced at runtime)
  description: string              // the discovery line (store card + the model's when-to-use)
  spec: CapabilitySpec
  visibility: CapabilityVisibility
  sharedWith: string[]             // target workspace ids (⊆ the AUTHOR's own memberships); only when visibility === 'subset'
  tags: string[]
  createdBy: string                // subject; owner
  createdAt: string
  // No updatedAt — versions are immutable (edit = publish a new version). Matches the registry entities.
}
```

## Visibility & sharing (the net-new part)

`private`/`workspace` reuse the exact `listVisible(tenant, subject)` pattern from `ViewStore`/`SkillStore`
(`visibility='workspace' OR created_by=subject`, scoped to the owning tenant). The two new tiers are the first
capabilities to be readable from a workspace other than the one they live in — but they are two very different acts:
`subset` fans a capability across **the author's own workspaces**, `public` exposes it to **everyone**.

- **subset** — the author shares to a chosen subset of **the workspaces they themselves are a member of**: "this
  skill, in 2 of my 5 workspaces." A multi-select over the author's own memberships → `sharedWith[]` (validated
  `⊆ memberships` at publish). A workspace `T` reads it iff `visibility='subset' AND T = ANY(sharedWith)` (the owner
  always reads); every member of a target workspace then sees it there. This is **not** publishing to strangers'
  workspaces — that is `public`. Because the targets are the author's own trust zones, no org/group tenancy layer and
  no accept/invite handshake is needed; the author fans out unilaterally and can revoke by dropping a workspace from
  `sharedWith`. Member-gated (a member owns fanning out their own capability).
- **public** — the real "expose to everyone" tier: readable by any authenticated subject in **any** Everdict
  workspace (a dedicated `listPublic()` read path, no tenant filter). This is where the genuine trust-boundary cost
  lives, so setting `visibility='public'` is **admin-gated by default** (publishing globally is a heavy act).
  **Instance policy (`EVERDICT_ALLOW_MEMBER_PUBLIC_PUBLISH`)** relaxes this: a self-hosted operator running a
  *community* instance sets it so **any member** — not only an admin — may publish/promote to `public`. It is a
  deployment property ("is this a shared-catalog instance?"), not per-workspace state, so it lives in operator config
  (no migration), is injected into `CapabilityService` as `allowMemberPublicPublish`, and is surfaced to the web on
  `GET /me → config.allowMemberPublicPublish` for UX gating (the service still enforces). The `mayPublishPublic(actor)`
  helper is the single authority — both `save()` (new-capability create) and `setVisibility()` (reach promotion)
  consult it.

A pure kernel in `@everdict/domain` — `canConsume(capability, { tenant, subject })` and
`visibleCapabilities(all, { tenant, subject })` — is the single authority, reused by the store service (browse) AND
the runtime resolver (adoption). Writes (edit-as-new-version / delete / change visibility) are **creator-or-admin,
owner-tenant only** — the same gate as `ViewService`, injected as `actor={subject,isAdmin}`.

## Adoption (reference, pinned, cross-tenant)

`AgentSpec` gains a `capabilities[]` field of pinned references; the existing `mcpServers[]` stays as the **raw
escape hatch** (power users, or a server not worth publishing — mirrors `openai-compatible` as the LLM escape hatch).

```ts
interface CapabilityRef {
  source: string                    // the owner workspace that published the capability (= my tenant for private/workspace)
  id: string
  version: string                   // the pinned immutable version (reproducible)
  // consumer-side binding, layered on the reference at adoption:
  secretBindings?: Record<string, string>  // required-secret name → one of MY workspace's secret names
  enableWrite?: boolean             // opt in to a write-capable mcp/code capability (default false)
}

// AgentSpecSchema gains:  capabilities: z.array(CapabilityRefSchema).default([])
```

Runtime resolution (`apps/agent/src/profile.ts`, per turn, best-effort like today's secret/skill resolution):
for each ref, `capabilityRegistry.getForConsumer(source, id, version, { tenant, subject })` loads the pinned record
**and re-checks `canConsume`** (access may have been revoked / unpublished → skip that capability, degrade, never
fail the turn). Resolved records are split by `spec.type` and handed to the type adapters below. Because the version
is immutable, an eval run that uses this agent is reproducible; the store surfaces "update available" by comparing a
ref's pinned version to the latest visible version.

**Skills become explicitly adopted, not ambient.** Once a capability can be `public`, auto-applying every visible
skill is absurd (you would inherit every public skill on Everdict). So an agent uses only the skill capabilities it
has adopted — a deliberate behavior change from today's `skillStore.list` ambient model, and the correct one for a
store.

## Version management (parity with the registry entities)

All four kinds (mcp | code | skill | environment) are versioned on ONE substrate, so versioning is uniform by
construction: `(tenant, id, version)` is immutable, a content edit auto patch-bumps (`latest` moves; pinned adoptions
stay reproducible), and per-version `tags` are mutable metadata OUTSIDE spec immutability. The full management surface
mirrors the registry entities (harness/dataset/judge/runtime) — one service core (`CapabilityService`), two transports
(BFF + MCP), one web drill-in:

- **List versions** — `GET /capabilities/:id/versions` + `list_capability_versions` → the ascending live versions plus
  a `version → tags` display map. `?source=` reads a cross-tenant public/subset owner (so the store can show the
  history of a capability published from another workspace).
- **Version tags** — `PUT /capabilities/:id/versions/:version/tags` + `set_capability_version_tags` → replace a
  version's free-form labels (trimmed / deduped, ≤20×60, reusing `normalizeVersionTags`). Gate: `capabilities:write`
  PLUS the version's creator-or-admin (the `deleteVersion` gate); own-workspace versions only.
- **Version diff** — `GET /capabilities/:id/diff?base=&candidate=` + `diff_capability_versions` → a structural diff over
  the immutable content (name/description/spec) via the shared `diffSpecFields` engine (the same one behind the
  harness/judge diffs); `typeChanged` flags an mcp ↔ code ↔ skill ↔ environment restructure. `?source=` diffs a
  cross-tenant public/subset owner. Reproducible by the immutable-version guarantee (`CapabilitySpecDiff`).
- **Reads** — `GET /capabilities/:id` and `GET /capabilities/:id/versions/:version` also take an optional `?source=`, so
  the store's version switcher can inspect an older version of a public capability owned by another workspace.
- **Web** — the store detail drill-in (`CapabilityVersionsPanel`) adds a version switcher (loads any version's spec),
  the shared `VersionTagsEditor` (`entity="capability"`, editable only for an own-workspace creator/admin), and an
  inline base ↔ candidate diff. Built-ins (`_everdict`) are code-defined single-version → no panel.

## Runtime consumption (per-type adapters)

`apps/agent/src/mcp-tools.ts` builds the `ToolRegistry`; each resolved capability becomes one or more
`ToolDefinition`s:

- **`mcp`** — two transports resolved in `profile.ts` to a `ResolvedMcpServer` union. **http** (`url`): each
  `secretBindings` value → workspace SecretStore value → `Authorization` header; connect via Streamable HTTP.
  **stdio** (`image`): each `requiredSecrets` → the adopter's bound secret value → a container env var; the agent
  connects via `StdioClientTransport` running `docker run --rm -i --env NAME … <image> [args]` (secret VALUES ride in
  the spawned process's env, only `--env NAME` on argv — no `ps`/log leak). Both bridge with `mcpToolToDefinition`,
  namespaced `mcp__<name>__<tool>`, write-filtered by `enableWrite`. stdio is skipped unless `AGENT_MCP_ALLOW_STDIO`
  is set, and skipped when a required secret is unbound. **Private images**: the docker CLI inherits the operator's
  host credentials (the agent forwards only `HOME`/`PATH` — not its own secrets — to the docker process), so a private
  image pulls via the host's `docker login` / credential helpers. Per-*workspace* registry credentials (the workspace
  image-registry pull auth) into the docker pull is a future item — the operator-host login covers the managed case.
- **`skill`** — feed `{name, description, instructions, files}` into the existing `buildSkillTools` → the `use_skill`
  (+ `read_skill_file` when files exist) tools. **Zero new runtime code.**

### Code-tool verification — nobody adopts by reading source

A code capability carries **worked `examples`** ({name?, input, note?} — concrete argument objects), and they do
triple duty: the store detail shows them (what the tool DOES, not just its code), the try-runner executes them, and
the agent bridge appends up to two to the bridged tool's description (the model learns the call shape from a real
invocation, alongside `parametersSchema`). Verification runs on the agent service (`POST /agent/code-tools/try`,
mirroring the skill test-drive):

- **check** — parse-only compile validation (`node --check` / `python3 -m py_compile`): the source is written into a
  fresh handle and parsed, never executed — safe for any target. The wizard offers it before publish.
- **run** — execute the tool against an example input under the agent's EXACT execution contract (input JSON as
  argv[1], last-JSON-on-stdout result, per-call handle, dispose in finally) and the same sandbox gate: a target from
  ANOTHER workspace runs only on an isolated runtime, refused otherwise. Targets are an unsaved draft `spec` (the
  wizard) or a published `{source,id,version}` ref (the store's try panel) — the ref is resolved and
  visibility-re-checked server-side, so the client never asserts trust. `requiredSecrets` bind by their declared name
  from the caller's workspace → personal secrets; unresolved names come back in `missingSecrets` so a failing run is
  explainable rather than mysterious.
- **`code`** — NEW. Register a `ToolDefinition` (`name` from the capability, `parametersJsonSchema` = the spec's
  `parametersSchema`, `isReadOnly` from the spec) whose `call(input, ctx)`:
  1. provisions a **sandbox** `ComputeHandle` (see security),
  2. writes the tool `input` (validated against `parametersSchema`) as a JSON context file,
  3. runs the pinned source (`python3 <script> <context-path>` — the **exact** script-grader contract from
     `packages/graders/src/script-grader.ts`: context JSON in, `ToolResult`-shaped JSON on stdout),
  4. parses stdout → `ToolResult`, disposes the handle in `finally`.

  This reuses the mature `Driver`/`ComputeHandle`/script-execution contract wholesale — the "new execution path" is a
  thin adapter, not new infrastructure.

## Security: `code` capabilities

A `public`/`subset` `code` capability means **running another workspace's code**. Non-negotiable:

- **Sandbox mandatory for adopted-from-others code** — a `code` capability whose `source !== tenant` runs in a
  hardened `DockerDriver` container (no host FS, network gated by policy), never `LocalDriver` on the control-plane
  host. Your-own-workspace code in dev may use `LocalDriver`.
- **Explicit consent at adoption** — adopting a `code` capability surfaces its (immutable, inspectable) source and
  requires an explicit confirm; the pinned version cannot change under you afterward.
- **`isReadOnly` honored** — a write-capable code tool goes through the same permission gate as write MCP tools.
- **`public` publish is admin-gated** and a candidate for later operator review.

## Authz

New resource actions on the domain matrix (`packages/domain/src/auth/authz.ts`), replacing the nascent `skills:*`:

- `capabilities:read` — viewer+ (browse the store, resolve adopted refs).
- `capabilities:write` — member+ (author / publish a new version / adopt into one's agent). Setting
  `visibility='public'` additionally requires admin (service-enforced via the injected `actor`, no separate action —
  avoids knob proliferation, mirrors the View gate).
- `capabilities:delete` — creator-or-admin (soft-delete a version / tombstone the capability).

## Architecture & slices

Follows the established entity pattern (service core + two transports [HTTP + MCP] + mem/Pg stores + Zod at every
boundary + a pure-HTTP web mirror), like `views`/`schedules`. Each phase ends on a green gate.

### Phase 1 — the `Capability` entity + visibility kernel + storage
- `@everdict/contracts`: `capability.ts` (`CapabilitySpec` discriminated union, `CapabilityRecord`,
  `CapabilityVisibility`, `CapabilityRef`); extend `AgentSpecSchema` with `capabilities[]`.
- `@everdict/domain`: the pure visibility kernel (`canConsume` / `visibleCapabilities`) + the three new authz actions.
- `@everdict/db`: `everdict_capabilities` migration — the versioned shape `(tenant, id, version, spec jsonb,
  created_at, created_by, deleted_at)` **plus** indexed `type`, `visibility`, `shared_with jsonb`, `tags jsonb`
  columns for the browse/visibility queries (a specialized versioned store, like `ViewStore` extends the base shape).
  Data migration folds `everdict_skills` → `type:'skill'` rows (`version 1.0.0`); `0071` becomes a no-op/dropped.
- `packages/registry` (or `db`): `CapabilityStore` — InMemory + Pg — `register` (immutable/soft-delete/revive),
  `getForConsumer` (visibility-checked, cross-tenant), `listVisible(tenant, subject)`, `listPublic`, `versions`,
  `softDelete`. Unit-tested against both impls.

### Phase 2 — control-plane API + MCP parity
- `apps/api`: `CapabilityService` (CRUD, publish-version, visibility change with the admin gate for `public`, adopt
  helpers) + routes `POST/GET /capabilities`, `GET /capabilities/:id/versions/:v`, `PATCH` (visibility/tags),
  `DELETE` + BFF↔MCP tools (`list/get/create/delete_capability`, `set_capability_visibility`). Gated on the new
  actions. Cross-tenant `listPublic`/subset reads honored.

### Phase 3 — adoption wiring
- `AgentSpec.capabilities[]` end-to-end: `agent-service` save path, `apps/agent/src/profile.ts` resolves refs
  cross-tenant + `canConsume` re-check + best-effort degrade; raw `mcpServers[]` retained as the escape hatch.

### Phase 4 — runtime adapters
- **4a** — `mcp` + `skill` capabilities load through the existing bridge / `use_skill` (reuse).
- **4b** — the `code` adapter: sandbox `ComputeHandle` provision + script-contract exec + `ToolResult` parse
  (`apps/agent` + a small shared exec helper reusing the driver/script-grader machinery).

### Phase 5 — the web store surface
- `apps/web`: `/{workspace}/store` — browse (union of visible capabilities; filter by type mcp/code/skill; search;
  tags; reach badge), detail (description · provides · required secrets · versions · author · **Adopt**), author flow
  (type picker → type-specific form: MCP url+required-secrets, code editor + params schema, skill instructions;
  visibility picker + a workspace-picker for `subset`). Settings › Agent lists adopted capabilities + secret
  bindings; **Settings › Skills migrates into the store**. FSD slices, next-intl catalogs, `settings-list`.

### Phase 6 — public hardening
- Enforce the sandbox for adopted-from-others `code`; adopt-time consent for `code`; the `public` admin gate; (later)
  operator review, ratings/usage, deprecation propagation.

## Web IA — management in Settings, the store as discovery (confirmed 2026-07-28)

The one store page originally mixed three different owners: browse/adopt (discovery), the workspace's own
publications (management), and the imported-environment inventory (`settings:write`-shaped workspace state). Confirmed
split — **no API/authz change, web IA only**:

- **`/store` = discovery only.** Browse + adopt/import over the public catalog (public + first-party managed
  capabilities); rows show an in-workspace badge instead of management actions. The workspace's own publications live
  on `/store/mine` (all kinds in one list) and in the kind-scoped Settings pages below — both render the same
  `CapabilityStore` `variant='mine'`.
- **Settings › Agent group = the agent as one concern**: `/settings/agent` (config + adopted refs + default-tool
  toggles) · `/settings/tools` (workspace-authored `mcp`/`code` capabilities: publish · version · reach · adopt) ·
  `/settings/skills` (living workspace skills) · `/settings/knowledge` (the knowledge graph, moved from the
  Workspace group).
- **Settings › Workspace › Environments** (`/settings/environments`) — environments are eval infra, not agent
  config, and (unlike tools) get a **dedicated environment-first surface, not the reused store chrome**
  (`EnvironmentWorkbench` + `EnvironmentEditor`, 2026-07-29): one unified list merges the workspace's authored
  `environment` capabilities with the imported-environment inventory per identity (`source/id`) — rows speak
  environment vocabulary (benchmark chip · visibility/pull badges · in-place expand rendering the agent-contract
  markdown + preset), with authored-row manage menu (edit / reach / delete), inventory re-check / remove, and an
  inline `auth`-failure escape to Settings › Integrations (registry + pull secret). Authoring is an
  environment-only dialog sectioned by journey (basics → image [+ registry tag helper] → contents → **agent
  contract** [scaffold template prompting entry points / result paths + markdown preview] → wiring preset
  [advanced, collapsed, live JSON validation] → reach), and **new environments default to `workspace`
  visibility** (team sharing is the surface's purpose; the store wizard's `private` default stays for other
  kinds). That default is the SERVICE's, not the form's (E6): `CapabilityService.save` picks the first
  version's reach by kind when the caller omits `visibility` — `environment` → `workspace`, tool kinds →
  `private` — so the API/MCP path (an agent registering the image a member just pushed) can't quietly create a
  team asset nobody but its author can see. A tool kind is one member's agent's until shared; an environment is
  what a harness pins, held workspace-wide on `WorkspaceSettings.adoptedEnvironments`. Discovery/import of other workspaces' environments stays in `/store` (linked). The store substrate
  (entity, versions, reach kernel, routes) is unchanged — presentation only.
- **Settings › Account › My tools & skills** (`/settings/personal-capabilities`) — the user-private scope:
  `visibility='private'` capabilities the user created + personal (private) skill drafts.

## First-party default toolset (confirmed 2026-07-27)

The store as designed above is **adopt-only**: a capability reaches an agent solely via an explicit
`AgentSpec.capabilities[]` pin. But an agent should ship with tools **out of the box** — web search, PDF reading, and
the "use the integration" actions for whatever integrations a workspace has configured — without any member browsing
the store first. And those same tools must stay **marketplace-installable** (a workspace can swap in a richer/custom
version). Confirmed direction (2026-07-27, with the user): deliver **both channels on one substrate** — the
`Capability` entity — by adding a **first-party, default-enabled tier**. No parallel "built-in tools" list in code; a
default IS a capability, so it is browsable, versioned, and replaceable like any other.

### The tier
- **First-party** = operator/Everdict-authored capabilities owned by a reserved `_everdict` tenant (mirrors the
  `_shared` registry fallback), readable by every workspace.
- **Browsable in the store** — the built-ins are code-defined (`firstPartyDefaults()`, not DB rows), so
  `CapabilityService.listPublic()` **merges them ahead of** the DB `public` catalog (`firstPartyCatalog` injected).
  This is what makes "the same tool, two channels" true in the store *surface*, not just in the agent runtime: the
  public tab shows the built-ins with a **"built-in" badge** (owner `_everdict`), and because they aren't DB rows they
  are **read-only** there (no edit/reach/delete — even for an admin) and shown as *provided by default* rather than an
  Adopt button (they're managed via Settings › Agent `disabledDefaults`, not adoption).
- **Default-enabled** = the agent includes them **without** an `AgentSpec.capabilities[]` pin. The effective toolset:
  ```
  first-party default capabilities (auto, gated)   ← web search · PDF · integration use-actions
  ∪ adopted capabilities (explicit pins)           ← richer / community / custom
  ∪ raw mcpServers[] (escape hatch)
  ```
- **Gated** — an integration default is on only when its integration is configured (Mattermost set → the Mattermost
  tools appear; GitHub App installed → the GitHub tools; a registry set → the image tools). A generic default (PDF) is
  unconditional; web search is on when a search-provider key is resolvable.
- **Opt-out & shadow** — `AgentSpec.disabledDefaults[]` (capability ids) turns a default off; adopting a capability
  with the same `name` shadows the default (the pinned, adopted version wins). Defaults never silently override a
  member's explicit choice.

### Secret resolution for first-party defaults
A default declares `requiredSecrets` like any capability, but its values resolve **from the workspace's existing
integration config**, not a manual `secretBindings` map at adoption (there is no adoption step):
- Mattermost tools → the configured bot token (`workspace/mattermost`).
- GitHub tools → the workspace GitHub App **installation token** (already minted for clone/CI).
- image-registry tools → the registry push/pull credentials.
- Web search → a search-provider key: an **operator-global** key (Everdict runs search for every workspace) or, absent
  that, a **workspace-bound** secret; unresolved → the tool is listed as "configure to enable," never a hard failure.

### Slices (additive to Phases 1–6)
- **Phase 7 — first-party tier mechanism.** Reserved `_everdict` owner + a `defaultEnabled` / `requires`
  (`mattermost | github | image-registry | null`) marking on the record; `CapabilityStore.listDefaults()`; a pure
  domain gate `applicableDefaults(defaults, { integrationsConfigured })`; `profile.ts` merges resolved defaults
  (secrets from integration config) with adopted caps and honors `disabledDefaults[]` + name-shadowing; web surfaces
  defaults in Settings › Agent (per-default toggle) and flags them "built-in" in the store.
- **Phase 8 — seed the generic tools.** A PDF `code` capability (python, extract text from a URL/artifact; no secret;
  default-on) and a web-search `code` capability (portable search API — Tavily/Brave/Serper — behind a search-provider
  key; default-on when resolvable). Portable API over any provider-native web_search so it works across Anthropic +
  OpenAI harnesses.
- **Phase 9 — rich integration adapters.** First-party `code` (or hosted `mcp`) capabilities beyond the current three
  use-actions: Mattermost (list channels · read/post thread), GitHub (create issue · comment on PR/issue · read repo
  file · list PRs/issues), image-registry (list images/tags · inspect) — each gated on its integration, secrets
  auto-bound from config, writes HITL-gated.
- **Phase 10 — first-party SKILLs over the integration actions (landed).** The `skill` kind joins the default tier: a
  first-party skill rides `AgentProfile.skills` → `use_skill` with zero new runtime code (the adapters were already
  generic). First seed: **`scorecard-fix-pr`** (`requires: "github"`) — the eval→fix loop as a procedure: diagnose a
  scorecard's failing cases from the eval evidence (scorecard/run/judge reads), locate the root cause in the harness's
  source repository (`get_github_file`), and open the fix PR via the `open_github_pr` action (branch → per-file
  commits → PR over the workspace GitHub App installation token, near-idempotent like the CI setup-PR, `github:write`,
  HITL-gated) — with the **experiment context** (scorecard link, harness@version × dataset@version, failing case ids +
  judge verdicts, evidence excerpts) MANDATORY in the PR body, so a reviewer judges the fix without re-running
  anything. With a gated default now real, the `integrationsConfigured` seam is wired: `apps/agent/src/main.ts`
  derives it per workspace from the settings store via the pure `configuredIntegrations` (`@everdict/domain`) — a
  gated default activates the moment its integration is configured, no adoption step.

The base control-plane surface is now **bridge-all** (docs/architecture/agent-conversations.md P13): every entity's
reads AND mutations reach the agent (only the runner wire-protocol tools are excluded), with each mutation decided by
the session's permission mode (default=ask · auto=ask only guarded actions · bypass · plan) on top of the RBAC. The
former curated `INTEGRATION_ACTIONS` admission list is gone — the integration "use" actions (post_mattermost_message,
open_ci_setup_pr, open_github_pr, …) are simply part of that surface, and they still migrate into first-party
integration capabilities as the richer Phase 9 adapters land.

## Fourth kind — `environment` (managed eval-environment images)

The substrate's extensibility claim has been exercised: `type:'environment'` publishes a **managed eval-environment
image** (pullable ref + composition preset + instructions) into the same store — consumed at harness-AUTHORING time
(template pins / service images), not adopted as an agent tool. Full design + slices:
`docs/architecture/environment-image-store.md`.

## Non-goals (this iteration)
- No org/group tenancy layer — `subset` is an explicit `sharedWith[]`.
- No accept/invite handshake for `subset` — the owner shares unilaterally (revocable).
- No live-reference adoption (auto-updating) — refs are pinned; upgrade is an explicit re-pin.
- No marketplace economy (payments/ratings/reviews) in v1 — provenance + "update available" only.
- No value-copy adoption — the catalog is the SSOT.

## Open questions
- **Secret-binding UX** for `mcp`/`code` at adoption — map each declared `requiredSecrets[].name` to a workspace
  secret via the existing `SecretPicker`; unbound required secret → block adoption or warn?
- **`public` moderation** — admin-gate is v1; do we need operator review / a report flow before a global marketplace?
- **`code` sandbox network policy** — default deny-all egress, or an allowlist the author declares and the adopter
  approves?
- **Namespacing collisions** across many adopted capabilities — `mcp__<name>__<tool>` / `code__<name>`; enforce
  unique `name` per agent at adoption.
- **Skill migration** — confirm `everdict_skills` has no production data worth preserving beyond the fold-in.
