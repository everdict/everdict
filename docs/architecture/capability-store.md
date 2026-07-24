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
  url: string                      // MCP endpoint (Streamable HTTP)
  provides?: string[]              // the tool names this server exposes (for the store card; discovery only)
  requiredSecrets: { name: string; description: string }[]  // secrets the ADOPTER must supply (declared, never valued)
  write: boolean                   // does this server offer mutating tools (adopter still opts in per-adoption)
}

interface CodeToolSpec {          // a python/node function Everdict runs and bridges as a callable tool
  type: 'code'
  language: 'python' | 'node'
  code: string                     // the source, pinned by version (immutable — auditable)
  parametersSchema: Record<string, unknown>  // JSON Schema for the tool's arguments (shown to the model verbatim)
  isReadOnly: boolean              // read-only tools skip the permission gate; writes require consent
  timeoutSec?: number
  image?: string                   // optional dedicated sandbox image (else the default hardened sandbox)
  requiredSecrets?: { name: string; description: string }[]  // env the adopter binds at adoption
}

interface SkillSpec {             // instructions-only (today's SkillRecord.instructions), now versioned + shareable
  type: 'skill'
  instructions: string             // the SKILL.md body, loaded on demand via use_skill
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
  lives, so setting `visibility='public'` is **admin-gated** (publishing globally is a heavy act; operator review is
  a later option).

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

## Runtime consumption (per-type adapters)

`apps/agent/src/mcp-tools.ts` builds the `ToolRegistry`; each resolved capability becomes one or more
`ToolDefinition`s:

- **`mcp`** — resolve each `secretBindings` value → workspace SecretStore value → `Authorization` header; connect via
  Streamable HTTP; bridge with `mcpToolToDefinition`, namespaced `mcp__<name>__<tool>`, write-filtered by
  `enableWrite`. **Identical to the current bridge** — zero new runtime code.
- **`skill`** — feed `{name, description, instructions}` into the existing `buildSkillTool` → the `use_skill` tool.
  **Zero new runtime code.**
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
