---
kind: wiki
title: "Capability Store (SSOT)"
status: current
updated: 2026-09-15
anchors: [packages/contracts/src/records/capability.ts, packages/domain/src/capability/capability-visibility.ts, apps/api/src/api/capability/capability.routes.ts, packages/application-control/src/agent/agent-capabilities.ts, apps/agent/src/code-tools.ts]
---
# Capability Store (SSOT)

> A **store** where a workspace's members author versioned capabilities, publish them at a reach tier, and adopt
> each other's instead of hand-typing a server URL. One discriminated `Capability` entity carries five kinds —
> `mcp` (a curated MCP connection), `code` (a python/node tool Everdict runs), `skill` (instructions a workspace
> copies into its skill library), `environment` (an eval-environment image) and `delegation` (a work environment
> Everdict hands work to). It mirrors the `Judge` kind idiom: one entity and one `type` discriminant, so a new kind
> is a new variant plus its consumer, with no new table, store, route or authz action. Adoption is by
> **immutable-version reference**, not by value copy.

## Why a store

Before it, the only agent tool channel was `AgentSpec.mcpServers[]`: a member hand-typed `{name, url, authSecret,
write}` per server. That channel is raw (every member re-discovers a server's URL and secrets), invisible to other
members, unshareable across workspaces, and MCP-only (a small python/node function needed a hosted MCP server).
`mcpServers[]` remains as the raw escape hatch; the store is a curation, discovery and sharing layer over the same
MCP bridge.

## Three layers

```
① CATALOG    CapabilityRecord — what exists to adopt (browse · publish · version)
             type ∈ { mcp | code | skill | environment | delegation }
             reach: private | workspace | subset(sharedWith[]) | public
             immutable versions + a pure reach kernel in @everdict/domain
                     │  browse / publish
                     ▼
② ADOPTION   mcp/code  → AgentSpec.capabilities[] = pinned {source, id, version} + consumer-side binding
             skill     → copied into the workspace skill library (SkillRecord)
             environment → imported into WorkspaceSettings.adoptedEnvironments
             delegation  → named by POST /sandboxes {profile}
                     │  resolve (cross-tenant, reach re-checked, best-effort)
                     ▼
③ RUNTIME    resolveAgentCapabilities (@everdict/application-control) decides the member's toolset;
             the agent's profile resolver shapes each enabled tool:
             • mcp  → mcpToolToDefinition bridge over Streamable HTTP (url) or a stdio container (image)
             • code → a code__<name> tool that runs the pinned source in a ComputeHandle
```

**Storage.** The `CapabilityStore` port (`packages/application-control/src/ports/capability-store.ts`) has InMemory
and Pg implementations in `packages/db/src/workspace/capability-store.ts` over `everdict_capabilities` (migration
0072): `(tenant, id, version)` primary key, indexed `type`/`visibility`, `shared_with`/`tags` jsonb, soft-delete
tombstones. Migration 0072 also seeded existing skills into the catalog as `type:'skill'` rows; `everdict_skills`
(0071) stayed, and it is still the skill library agents read.

## The `Capability` model

The Zod schema is the SSOT (`packages/contracts/src/records/capability.ts`); types are `z.infer`red and the spec is
a discriminated union.

```ts
type CapabilityVisibility = 'private' | 'workspace' | 'subset' | 'public'

interface McpToolSpec {
  type: 'mcp'
  url?: string              // remote Streamable-HTTP endpoint; requiredSecrets[0] → Authorization header
  image?: string            // `docker run --rm -i <image> [args]` (MCP over stdio); requiredSecrets → container env
  args: string[]            // trailing args after the image (stdio only)
  provides: string[]        // declared tool names (store card / discovery only)
  requiredSecrets: { name: string; description: string }[]  // names the adopter binds, never values
  write: boolean            // offers mutating tools (the adopter still opts in with enableWrite)
  effects?: EffectContract  // required when write = true
}

interface CodeToolSpec {
  type: 'code'
  language: 'python' | 'node'
  code: string                               // the pinned source
  parametersSchema: Record<string, unknown>  // JSON Schema shown to the model verbatim
  isReadOnly: boolean                        // default true
  requiredSecrets: { name: string; description: string }[]
  timeoutSec?: number
  image?: string                             // dedicated sandbox image
  examples: { name?: string; input: Record<string, unknown>; note?: string }[]  // at most 8
  effects?: EffectContract                   // required when isReadOnly = false
}

interface SkillCapabilitySpec { type: 'skill'; instructions: string; files: SkillFile[] }
// EnvironmentImageSpec  — see environment-image-store.md
// DelegationProfileSpec — see "Fifth kind" below

interface CapabilityRecord {
  id: string
  tenant: string            // the OWNER workspace (the publisher)
  version: string           // immutable; new content = new version
  name: string              // the name the agent sees (namespaced at runtime)
  description: string       // store card + the model's when-to-use
  spec: CapabilitySpec
  visibility: CapabilityVisibility
  sharedWith: string[]      // target workspace ids; only meaningful for 'subset'
  tags: string[]
  createdBy: string
  createdAt: string         // no updatedAt — editing content publishes a new version
}
```

- **Exactly one MCP transport** is enforced at the save boundary (`SaveCapabilityBodySchema.superRefine`), not in
  the union, because a discriminated-union member cannot be a refined schema. The runtime prefers `image`, else `url`.
- **Effect contract.** A write-capable `mcp` or `code` spec must declare `effects` (side effect, idempotency,
  rollback, partial failure, data access): `assertCapabilityEffects`
  (`packages/domain/src/capability/effect-contract.ts`) refuses the save otherwise, and `effectsRequireConsent`
  decides whether a call keeps asking a human in auto mode.
- **stdio servers are operator-gated.** The agent spawns `docker run` only when `AGENT_MCP_ALLOW_STDIO` is `1` or
  `true`, and, if `AGENT_MCP_STDIO_ALLOWED_IMAGES` lists images, only for those; otherwise the capability is skipped,
  never failed. Curated image-transport servers ship in `firstPartyCatalogExtras()` — Grafana, Playwright, Postgres —
  as public, adoptable entries that are not enabled by default.

## Visibility & sharing

`canConsumeCapability(capability, { tenant, subject })` (`packages/domain/src/capability/capability-visibility.ts`)
is the single authority for reading or using a capability. The store service (get, versions, diff), the agent
resolver (adopted refs) and the code try-runner all call it, and the Pg store's SQL mirrors it.

- **private** — the creator, in the owning workspace only.
- **workspace** — any member of the owning workspace.
- **subset** — the owning workspace plus every workspace id in `sharedWith`; another workspace never reads a
  `private` or `workspace` capability. It exists to fan a capability across the author's own workspaces ("this
  skill, in 2 of my 5"), and the web picker offers only workspaces the author belongs to. The server does not check
  `sharedWith` against memberships.
- **public** — every workspace, through `listPublic()` (no tenant filter). Publishing or promoting to `public` is
  admin-only unless the operator sets `EVERDICT_ALLOW_MEMBER_PUBLIC_PUBLISH=1` — a deployment property (a community
  instance), injected into `CapabilityService` as `allowMemberPublicPublish` and surfaced on `GET /me` →
  `config.allowMemberPublicPublish` for UX gating only. `mayPublishPublic(actor)` is consulted by both `save()` (a new
  capability) and `setVisibility()` (a reach change).

A capability the caller cannot see answers 404, so a foreign private publication is indistinguishable from a missing
one.

**Writes are owner-workspace only.** A new version or a reach change needs the capability's latest creator or an
admin; tag edits and version deletes need that version's creator or an admin. `visibility`/`sharedWith` apply only
when creating: a content edit inherits the reach, which changes only through `PATCH /capabilities/:id/visibility`.
When `visibility` is omitted on create, `CapabilityService.save` picks it by kind — `environment` → `workspace` (the
image a harness pins is a team asset), every other kind → `private`.

## Authz

Actions on the domain matrix (`packages/domain/src/auth/authz.ts`):

- `capabilities:read` — viewer+ (browse the store, resolve adopted refs).
- `capabilities:write` — member+ (author, publish a version, change reach, tag, delete a version). Every capability
  write route gates on it; the service adds the creator-or-admin and public gates above.
- `capabilities:delete` — admin; `deleteVersion` also accepts the version's creator.

Skills keep their own `skills:read`/`skills:write`. Adopting into an agent is `agents:write`; importing an
environment is `settings:write`.

## HTTP + MCP surface

`apps/api/src/api/capability/capability.routes.ts`, with MCP twins in `capability.mcp.ts`:

| HTTP | MCP |
|---|---|
| `GET /capabilities` — what this workspace can use without the public catalog | `list_capabilities` |
| `GET /capabilities/public` — first-party built-ins first, then every `public` row | `list_public_capabilities` |
| `GET /capabilities/:id`, `GET /capabilities/:id/versions/:version` (`?source=`) | `get_capability` |
| `GET /capabilities/:id/versions` (`?source=`) | `list_capability_versions` |
| `GET /capabilities/:id/diff?base=&candidate=` (`?source=`) | `diff_capability_versions` |
| `PUT /capabilities/:id` — version-free upsert | `save_capability` |
| `POST /capabilities/validate` | `validate_capability` |
| `POST /capabilities/probe-mcp` | `probe_capability_mcp` |
| `PATCH /capabilities/:id/visibility` | `set_capability_visibility` |
| `PUT /capabilities/:id/versions/:version/tags` | `set_capability_version_tags` |
| `DELETE /capabilities/:id/versions/:version` | `delete_capability` |

`?source=` reads a capability owned by another workspace (public or subset-shared to the caller).

## Version management

All kinds are versioned on one substrate. `PUT /capabilities/:id` registers `1.0.0` for a new id, patch-bumps on
changed content (`latest` moves, pinned adoptions stay reproducible) and is a no-op on identical content.
`visibility`, `sharedWith` and per-version `tags` are mutable metadata outside spec immutability.

- **List versions** — the ascending live versions plus a `version → tags` display map.
- **Version tags** — replace one version's free-form labels, trimmed, deduped and capped (≤20×60) by
  `normalizeVersionTags`; own-workspace versions only.
- **Version diff** — `diffCapabilitySpecs` runs the shared `diffSpecFields` engine (the one behind the harness and
  judge diffs) over name/description/spec and returns a `CapabilitySpecDiff`; `typeChanged` flags a kind change.
- **Web** — the store detail's `CapabilityVersionsPanel` loads any version's spec, edits tags through the shared
  `VersionTagsEditor` (own-workspace creator or admin only) and shows an inline base ↔ candidate diff. First-party
  built-ins are code-defined single versions and get no panel.

## Adoption (reference, pinned, cross-tenant)

```ts
interface CapabilityRef {                  // AgentSpec.capabilities[]
  source: string                           // the owner workspace (= my tenant for private/workspace)
  id: string
  version: string                          // the pinned immutable version
  secretBindings: Record<string, string>   // requiredSecrets[].name → one of MY secret names
  enableWrite: boolean                     // opt in to a write-capable mcp/code capability (default false)
}
```

On the store detail page, adopting a capability that declares secrets or offers writes opens a dialog to bind the
secrets and opt in to writes; otherwise it is one click. Every resolution re-reads the pinned version
(`CapabilityStore.getVersion`) and re-checks `canConsumeCapability`; a revoked or unpublished capability is skipped,
never a failed turn. Because the version is immutable, an eval run using the agent is reproducible.

Only `mcp` and `code` capabilities become agent tools.

## Runtime consumption (per-type adapters)

`apps/agent/src/profile.ts` calls `resolveAgentCapabilities` on every turn and shapes each enabled tool;
`apps/agent/src/mcp-tools.ts` builds the `ToolRegistry`.

- **`mcp` over http** (`url`) — the first declared secret's bound value becomes the `Authorization` header. The server
  is bridged with `mcpToolToDefinition`, namespaced `mcp__<name>__<tool>`; unless the adoption enabled writes, only
  read tools are bridged.
- **`mcp` over stdio** (`image`) — each required secret's bound value becomes a container env var, and
  `StdioClientTransport` runs `docker run --rm -i --env NAME … <image> [args]`, so values ride in the spawned
  process's environment and only names reach argv. An unbound required secret drops the server. The docker CLI
  receives the bound secrets plus `HOME`/`PATH` only, so a private image pulls with the operator host's
  `docker login`; per-workspace registry credentials are not wired into this pull.
- **`code`** — a `code__<name>` tool (`apps/agent/src/code-tools.ts`). Each call provisions a `ComputeHandle`, writes
  the input JSON to a sandbox-relative file, runs `python3`/`node` with that path as its argument, reads the last
  JSON value on stdout (`{content, isError?}`) as the `ToolResult`, and disposes the handle in `finally` — the
  script-grader contract (`packages/graders/src/script-grader.ts`). Up to two `examples` are appended to the tool
  description so the model sees a real call shape.

A bridged name has one spelling — `mcpBridgedName`/`codeBridgedName` in
`packages/domain/src/capability/tool-naming.ts` — used by the runtime and by the tool detail page.

### Code-tool verification — nobody adopts by reading source

`POST /agent/code-tools/try` (`apps/agent/src/code-try.ts`) verifies a code tool before anyone depends on it:

- **check** — parse-only (`node --check` / `python3 -m py_compile`); never executes, so it is safe for any target.
  The publish wizard offers it.
- **run** — executes one example input under the runtime's exact contract and sandbox gate. The target is an unsaved
  draft `spec` (the wizard) or a published `{source, id, version}` ref (the store's try panel), resolved and
  reach-checked server-side so the client never asserts trust; a first-party default resolves from its shipped
  definition. Required secrets bind by declared name from the caller's workspace, then personal, secrets; unresolved
  names come back in `missingSecrets`.

## Security: `code` capabilities

- **Code from another workspace needs an isolated runtime.** A resolved code tool is marked `sandbox` when its owner
  is not the reading workspace (first-party code is trusted). `buildCodeTools` registers such a tool only on an
  isolated `CodeToolRuntime` and skips it otherwise; the try-runner refuses it the same way. The agent service
  composes a `LocalDriver` runtime (`isolated: false`), so today own-workspace and first-party code runs and code
  adopted from another workspace is skipped.
- **Writes go through the permission gate** — `isReadOnly: false` and the declared `effects` reach the consent gate
  exactly as a write MCP tool's do.
- **Inspection before adoption** — the store detail shows the pinned source and worked examples and hosts the
  try-runner.

## Web surfaces

- **`/{workspace}/store`** — browse-only over the public catalog (first-party built-ins plus every `public`
  capability); rows already in the workspace carry a badge.
- **`/{workspace}/store/mine`** — the workspace's own publications of every kind and reach (the web `CapabilityStore`
  component with `variant='mine'`): publish, edit, change reach, delete. First-party entries are excluded.
- **Sidebar › Agent** — `/{workspace}/tools` and `/{workspace}/skills` (the member's toolset and the skill library,
  below) next to the store.
- **Settings › Agent** (`/settings/agent`) — the workspace's agents; an agent's page holds its config, its adopted
  references and the built-in default-tool toggles (`AgentSpec.disabledDefaults`).
- **Settings › Workspace › Environments** (`/settings/environments`) — environments are eval infrastructure, not
  agent config, so they get an environment-first surface rather than the store chrome: `EnvironmentWorkbench` merges
  the workspace's authored `environment` capabilities with the imported inventory per `source/id` (with an inline
  escape to Settings › Integrations when a pull fails on auth), and `EnvironmentEditor` authors one, defaulting to
  `workspace` reach. Discovering other workspaces' environments stays in the store.

### The store DETAIL is a route, not a dialog

A store row links to `/{workspace}/store/{source}/{id}` (`?from=mine` when the entry point was the workspace's own
publications — it picks the back link and shows the reach badge). The right-hand infra/chat panel is half the
workflow, a full-screen spec (code + try-runner, SKILL.md + attachments, an environment's agent contract) does not
belong in a box over the list, and a published capability deserves an address a member can share.

- The page fetches the record server-side (`GET /capabilities/:id?source=`; first-party `_everdict` entries resolve
  there too) and 404s on anything the caller cannot see. `?version=` is not part of the address: the version switcher is an
  on-demand client read, because an old version is a lens on the same entity.
- **The detail is the only surface that adds or removes.** `CapabilityDetailView` owns the per-kind decision: agent
  adoption (`agents:write`, with the secret-binding / write opt-in dialog), skill copy into the library
  (`skills:write`), environment import and pull re-check (`settings:write`). Server actions revalidate the list
  surfaces and this route, and the page calls `router.refresh()` to re-read its own "in your workspace" state.

## The member's agent: Tools + Skills are per member

A workspace is not one agent. The workspace is the shared BASELINE — which tools and skills it supports — and each
member overlays their own on/off on top of it.

- **Both pages are a list and a switch.** `/{workspace}/tools` shows every tool the caller can put on their agent;
  `/{workspace}/skills` is the skill library (create · generate · edit · share · delete) with a per-row "use" switch.
  Rows group by `AgentToolScope`: `personal` (the member's own private publications or drafts) · `workspace` (adopted
  on the AgentSpec, hand-wired in `mcpServers[]`, authored here, or published workspace-wide) · `builtin` (first-party
  defaults). Publishing, versioning, reach and the catalog stay in the store.
- **The overlay.** `AgentMemberPreferences` (`(tenant, subject) → {tools, skills, model}`, migrations 0090 and 0167)
  is self-scoped, like a personal secret. An ABSENT key follows the workspace: resetting an override deletes the key
  rather than freezing today's baseline, so a later workspace change still reaches that member. Keys namespace the
  channels: `default:<id>` · `capability:<owner>/<id>` · `mcp:<name>` (tools) · `skill:<id>` (an authored skill).
- **The baselines.** On for everyone: adopted capabilities, hand-wired MCP servers, the workspace's authored skills
  (plus the caller's own drafts), and first-party defaults the workspace has not opted out of. Listed but off until
  the member switches them on: `mcp`/`code` capabilities published in this workspace that the agent has not adopted,
  and the member's own private tool publications.
- **One decision point.** `resolveAgentCapabilities` builds both candidate pools in one pass — tools in runtime
  priority order (hand-wired servers → adopted → merely available → first-party defaults), skills from the
  workspace's own `SkillRecord`s only — overlays the member's preferences, and resolves name collisions with the pure
  `selectForMember` kernel (`@everdict/domain`): the first enabled candidate for a name wins and the rest report
  `shadowedBy`. The pages (`GET/PUT /agent/tools`, `GET/PUT /agent/skills`; MCP `list_agent_tools`/`set_agent_tool`/
  `list_agent_skills`/`set_agent_skill`) and the agent runtime (keyed by `principal.subject`) read the same answer,
  so what a member configures and what their agent carries cannot disagree. Shadowing is per channel: a tool and a
  skill may share a name, because the model reaches them through different doors.
- **A third channel rides the same overlay: the model.** `AgentMemberPreferences.model` (`GET/PUT /agent/model`,
  MCP `get_agent_model`/`set_agent_model`, Settings › Account › Preferences) is not a capability decision and is not
  part of `resolveAgentCapabilities`. The profile resolver reads it for the workspace chat agent only (a crafted
  agent's model is part of its identity), and `null` follows the workspace's `AgentSpec.model`. Resolution order:
  [models.md](../models.md) §"Which model a CONVERSATION runs on".

### The tool DETAIL

`/{workspace}/tool/<urlencoded key>` is the explanation behind the switch — a routed page, never a dialog.
`GET /agent/tools/:key` (`get_agent_tool`) returns the row plus what the tool is, derived from the same resolver pass
the runtime uses:

- **`transport`** — `http` (open an MCP session) · `stdio` (`docker run -i` a container) · `code` (run the source in
  a sandbox).
- **`functions`** — what the tool puts in front of the model, under its bridged name. The declared list is the
  author's `provides` (a `code` tool is exactly one function); `POST /agent/tools/:key/probe` (`probe_agent_tool`)
  connects as this member with their bound secret and replaces it with the server's own answer. Probing is HTTP-MCP
  only (`probeable`); a code tool is verified by running it with the try-runner.
- **`secrets`** — each declared name, the secret name it reads, and whether the member can satisfy it. The binding
  lives on the AgentSpec: an adopted capability's `CapabilityRef.secretBindings`, a hand-wired server's `authSecret`,
  and, for a first-party default or an unadopted publication, the spec-level `toolSecretBindings` overlay (tool key →
  declared name → secret name; without an entry they bind by the declared name). `PUT /agent/tools/:key/secrets`
  (`bind_agent_tool_secrets`, `agents:write`) rewrites any of them and registers a new agent version, bootstrapping
  the chat config when a fresh workspace has none. Binding a workspace-tier secret additionally needs `secrets:read`,
  because its value is sent to an endpoint a member can author. Names only, never values.
- **Editing is the chat, not a form.** When `editable` (a capability this workspace owns), "Edit in chat" drops a
  `tool` reference (carrying `source`) and frames the panel with the `toolEdit` mission; the agent reads the spec with
  `get_capability` and publishes a new version with `save_capability` under approval. Built-ins and other workspaces'
  publications are read-only here.

## First-party default toolset

An agent ships with tools out of the box, and those tools stay replaceable. A default IS a capability — browsable,
versioned and shadowable like any other — so there is no parallel built-in list.

- **Owner** — the reserved `_everdict` tenant (`FIRST_PARTY_TENANT`), readable by every workspace. The records are
  code-defined in `packages/application-control/src/capability/first-party.ts`, not DB rows: `CapabilityService`
  merges the injected `firstPartyCatalog` (`firstPartyDefaults()` + `firstPartyCatalogExtras()`) ahead of the DB
  `public` catalog and resolves those entries by `(source, id)`. In the store they carry a built-in badge and are
  read-only, even for an admin.
- **The defaults** are three `code` tools with no integration requirement: `web_search` (declares `TAVILY_API_KEY`),
  `fetch_url` and `pdf_read`.
- **Effective toolset** — a default is included without a `capabilities[]` pin, subject to
  `AgentSpec.disabledDefaults[]` (by capability id) and the member overlay; a same-named hand-wired, adopted or
  available tool shadows it.
- **Secrets** — a default resolves each declared secret from an operator-global value first
  (`AGENT_WEBSEARCH_API_KEY` supplies `TAVILY_API_KEY`), then from the workspace/personal secret of that name. A
  default whose declared secrets resolve to nothing is not offered to the model.
- **Integration gate** — `CapabilityRequirement` (`mattermost | github | image-registry`), `configuredIntegrations`
  and `selectDefaultCapabilities` (`@everdict/domain`) can gate a default on a configured integration, but no shipped
  default declares one. The Mattermost, GitHub and image-registry actions (`post_mattermost_message`,
  `open_github_pr`, `get_github_file`, `open_ci_setup_pr`, …) are control-plane MCP tools, whose credentials live
  server-side.

The agent's base control-plane surface is bridge-all ([agent-conversations.md](agent-conversations.md) P13): every
entity's reads and mutations reach the agent except the runner wire-protocol tools, each mutation decided by the
session's permission mode (default · auto · bypass · plan) on top of RBAC.

### First-party skills are store examples, not defaults

Everdict authors skills — `scorecard-fix-pr`, `trace-analysis`, `memory-consolidation`, `delegate-work`,
`agent-evolve`, `harness-evolve`, `code-evolve` (`firstPartySkillExamples()`) — and ships them as public catalog
entries that a workspace takes.

- **A skill is a document a workspace owns.** A silent default would put a procedure in every workspace's agent that
  nobody there wrote, can edit or can version. Tools stay defaults (nobody edits `web_search`); skills do not.
- **Taking one COPIES it** (`POST /skills/import`, MCP `import_skill` → `SkillService.importFromStore`): the content
  lands as an ordinary `SkillRecord` (`visibility: workspace` unless the caller says otherwise), its version line
  starting at the copied version, with `origin: {source, id, version, name}` as provenance — never a live link, which
  would either fight later edits or lie about them. Taking the same publication twice is 409.
- **Skill-kind capabilities are not agent attachments.** Skills resolve from the workspace's own `SkillRecord`s only,
  so the Skills page lists exactly what the agent follows and every entry is editable by the people it belongs to.
  Publishing a skill hands others something to copy; it adds no second row to anyone's library, the author's
  included.

See "Skill versions" below.

## Fourth kind — `environment` (managed eval-environment images)

`type:'environment'` publishes a managed eval-environment image (pullable ref + composition preset + instructions)
into the same store. It is consumed at harness-authoring time (template pins, service images), never adopted as an
agent tool. Full description: [environment-image-store.md](environment-image-store.md).

## Fifth kind — `delegation` (a work environment everdict hands work TO)

The other kinds describe what an agent USES. `type:'delegation'` describes an environment everdict **employs**: a
registered work-agent it can hand a job to and converse with until the job is done.

**Why a capability and not a harness.** A harness is the agent *under test* — the eval lane's subject. A delegate is
the worker. What a workspace needs of it is what the store already provides: versioning, the reach tiers,
cross-tenant sharing, adopt-and-edit, and a first-party example to start from (`code-delegate`,
`firstPartyDelegationExamples()`).

**What it pins** — one reference collapses what a delegation otherwise re-specifies per call: `harness` (which
conversational agent runs — any adapter carrying the `conversational` marker) · `image` (prebuilt, so a delegation
costs no per-session install) · `model` (a registered Model → baseUrl + underlying model + key, `ModelRef.env`
remapping included) · `env` (literal or `{secretRef, scope}`) · `workDir` (the conversation's stable cwd) ·
`instructions` + `instructionsFile` (the STANDING brief, seeded as the file that agent reads by convention —
CLAUDE.md · AGENTS.md · …) · `ttlSec` · `network` (the `NetworkPolicy` the session's box must enforce).

**Env precedence, stated once**: `harnessAuthEnv` (workspace→personal tiers) < the profile's own `env` < the model's
connection env. It is the same "model wins" rule the eval lane applies, so a profile and a harness never disagree
about who owns the endpoint.

**The handoff is a contract, not a prose blob.** `POST /sandboxes {profile, brief}` — the brief (goal · context ·
references · constraints · done-criteria) is rendered once (`renderDelegationBrief`, `@everdict/domain`), written into
the delegate's working directory as `BRIEF.md` **before the ledger row exists** (a delegate that silently never got
its context is the failure this ordering prevents), and sealed on the session trajectory as a `delegation.brief`
marker, so the ledger alone answers what the delegate was asked to do. A profile session is always a conversation;
turns run in the profile's own `workDir`, never a per-task scope.

**WHO is a separate axis from WHERE.** A profile is an overlay on the session's target, not a boot mode: alone it runs
in its own image; with `world` it continues that world (its work hibernates into the next snapshot) or founds one,
taking the profile's image as the genesis base when the caller names none; with `environment` or `image` it works in
that one; `repo` clones in as usual. The only conflict is `harness`, which also says who runs.

Refused by name: a brief without a profile, `profile` + `harness`, a profile whose harness cannot converse, and a
profile naming a secret the workspace has not set.

**Scope note (live-verified)**: the profile's `env` is the DELEGATE's environment — it reaches the agent adapter, not
the session's `exec` channel (which is the operator's own shell, and has never carried `apiKeyEnv` either). If a
delegation needs a variable present for hand-run commands too, bake it into the image; making `exec` inherit the
agent's environment would quietly hand an operator shell the delegate's credentials.

## Skill versions

A workspace skill carries its own semver, so "edit it in conversation, then stamp the version" is a real loop:

- **The row is the WORKING COPY.** Members (and the agent, via `update_skill` under the session's permission mode)
  edit it freely; `SkillRecord.version` names the last content the workspace decided to publish, not every keystroke.
- **A stamp freezes content** (`POST /skills/:id/versions` / MCP `stamp_skill_version`): `bump` (major|minor|patch,
  default patch) or an explicit version that must order above the current one (else 400), plus an optional `note`
  (the changelog line). The snapshot is immutable — re-stamping a live version is 409 — which is what makes "what did
  this procedure say when we ran that eval?" answerable. Content is read filesystem-first, so a body an agent rewrote
  through the workspace filesystem is what gets frozen.
- **A stamp is not an edit**: `updatedAt` stays put, so the newest stamp's `stampedAt` earlier than
  `skill.updatedAt` means "changed since the last stamp", shown as a badge next to the version on the skill detail.
- Storage: `everdict_skills.version` + `everdict_skills.origin` (jsonb) and the `everdict_skill_versions` table
  (migration 0091), behind the `SkillVersionStore` port — kept out of `SkillStore` because the row is read on every
  agent turn and the line only when someone opens the version panel (the same split as `WorkspaceFs` ←
  `FsRevisionStore`).

## Not built

- No org/group tenancy layer and no accept/invite handshake — `subset` is an explicit `sharedWith[]` the owner edits
  unilaterally.
- No auto-updating references — refs are pinned and an upgrade is an explicit re-pin; the store shows no "update
  available" or adoption counts.
- No marketplace economy (payments, ratings, reviews) and no operator review of `public` publications beyond the
  admin gate.
- No isolated code runtime composed into the agent service (see "Security").
