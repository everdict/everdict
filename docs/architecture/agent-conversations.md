# Agent conversations — a conversational, multi-turn agent over the eval control plane

> **Status: P1–P5 LANDED (local, unpushed) — kernel + contracts/store + `apps/agent` + web panel; all
> automated gates green (full turbo typecheck+test 70/70, cone, web-imports, web build). Remaining: a LIVE e2e
> against a running stack + a registered workspace model, and dev `up.sh` wiring.**
>
> Everdict runs and evaluates *other people's* agent harnesses. This feature adds Everdict's **own** agent:
> a conversational, multi-turn, tool-using LLM agent that a workspace member talks to from the web to
> **review harnesses, analyze scorecards / judge traces, and inspect runtime resources** — the platform
> reasoning about its own eval data. The "agent" entity name was deliberately freed for exactly this by the
> earlier `agent → job-runner` rename (the dispatched worker is now `@everdict/job-runner`; "agent" = a real
> LLM agent).
>
> The agentic loop is **ported from `workspaces/digo-data/apps/digo-agent`** — a from-scratch, Claude-Code-style
> agentic runtime (loop + context compaction + tool registry with ToolSearch progressive disclosure + MCP
> bridge + observability). We bring its **domain-agnostic kernel** (`src/runtime/*`) over as a reusable package
> and leave its digo product domain behind. "Reinterpret, don't copy" (CLAUDE.md §4): the port is adapted to
> everdict conventions (`AppError`, Zod boundaries, no `any`/`!`, `.js` ESM imports).

## Decisions locked with the maintainer

- **D1 — separate `apps/agent` server.** The loop runs as its own Fastify service (mirroring digo's
  `digo-admin ↔ digo-agent` split), **not** folded into `apps/api`. It reaches the control plane as an **MCP
  client** of `apps/api`'s `/mcp` (Streamable HTTP), consistent with CLAUDE.md's "Humans→Keycloak; agents→MCP".
  The reusable kernel lives in `packages/agent-runtime` so a later in-process host stays possible.
- **D2 — read-only first.** The first slice exposes only **read-only** control-plane tools (list/get scorecards,
  inspect trace, diff, get queue, inspect runtime, list runs, get run logs). Write actions (`run_scorecard`,
  `create_comment`, `control_runtime`) come in a later slice behind a permission/approval (HITL) gate — the
  digo `permissions` subsystem is ported then, not now.
- **D3 — workspace model↔secret binding.** The agent's LLM uses the workspace's own registered model + key,
  via the existing `ModelSpec` registry + `SecretStore` (`modelConnectionEnv` / `modelApiKeySecretName` in
  `packages/domain/src/harness/model-binding.ts`). The tenant's key is used and cost is attributed to them.
- **D4 — web surface = a right-panel tab.** Agent conversations appear as a new **`agent` tab in the infra
  split-view panel** (`apps/web/src/widgets/infra-panel`), next to schedules/runtimes/runs/work — an embedded
  component (like `WorkTab`), not an iframe-hosted page. History is a session list; a session is a streaming
  multi-turn chat. MVP transport is **polling** (mirroring `widgets/live-logs`), upgradeable to SSE later.

## Architecture

```
apps/web (infra-panel 'agent' tab)
  │  BFF proxy /api/agent/*  (forwards Keycloak bearer)
  ▼
apps/agent  (Fastify, @everdict/auth → Principal, workspace-scoped)
  │  sessions/messages  ─────────────►  AgentSessionStore (@everdict/db, Pg/InMemory)
  │  chat  ──runs──►  @everdict/agent-runtime  (ported kernel: loop · llm · context · tools · mcp bridge)
  │                        │  LLM   ──►  workspace ModelSpec + SecretStore key (openai-compatible client)
  │                        │  tools ──►  MCP client  ──(caller bearer)──►  apps/api /mcp  (read-only subset)
  ▼
apps/api /mcp  (existing 121-tool surface; agent reuses it — dogfooding)
```

### `packages/agent-runtime` — the ported kernel (domain-agnostic)

Depends only on `@everdict/contracts` + `openai` + `@modelcontextprotocol/sdk` + `zod`. Reinterpreted from
`digo-agent/src/runtime/*` ([kernel map is faithful to Claude Code](../../../digo-data/apps/digo-agent/.claude/skills/claude-code-follow/SKILL.md)):

| area | ported from | purpose |
|---|---|---|
| `kernel/loop` + `agenticAdapter` + `messages` + `normalize` + `systemPrompt` | `runtime/kernel/*` | one turn = LLM call → dispatch tool calls → feed results → repeat until `end_turn`/`max_turns`/budget/aborted |
| `@everdict/llm` `LlmTransport` (injected) + `llm/summarize` | `runtime/llm/*` | **provider-NATIVE transport** (Anthropic Messages / OpenAI, native protocol + prompt/KV caching) selected by `ModelSpec.provider`; `stream()` for the turn (tool-calling), `complete()` one-shot for compaction. NOT provider-agnostic-over-LiteLLM — a custom `baseUrl` = the `openai-compatible` escape hatch |
| `context/{tokenBudget,microCompact,compaction}` | `runtime/context/*` | context-window compaction at ~90% budget (micro → LLM → structural) |
| `tools/{definition,registry,invocation,deferred,ToolSearchTool,openai}` | `runtime/tools/*` | tool contract + registry + **ToolSearch progressive disclosure** (deferred MCP tools stay hidden until discovered — critical with ~121 MCP tools vs. context budget) |
| `mcp/{client,bridge,discovery}` | `runtime/mcp/*` | bridge MCP tools → `ToolDefinition` (marked deferred); the transport/session is injected by the host |

Deferred for later slices (not ported in slice 1): `skills`, `permissions` (read-only ⇒ no HITL yet), `tasks`,
`work-plans`, `memory`, `replays`, `evals`, digo `data-sources` / `agents` domain.

### `apps/agent` — the server

- **Auth**: `@everdict/auth` composite (Keycloak JWT + `ak_` API key) → `Principal{subject,workspace,roles}`.
- **Routes**: `POST /agent/sessions`, `GET /agent/sessions`, `GET /agent/sessions/:id`,
  `GET /agent/sessions/:id/messages` (supports `?since=`), `POST /agent/sessions/:id/chat`.
- **Tools**: on chat, open a `ResilientMcpSession` (pattern from `packages/self-hosted-runner/src/runner-session.ts`)
  to `EVERDICT_MCP_URL` **forwarding the caller's bearer**, list tools, keep the **read-only allowlist**, bridge
  them into the runtime registry (deferred + ToolSearch).
- **LLM**: resolve the workspace's chosen `ModelSpec` (model registry) → provider/baseURL/underlying model +
  decrypted key from `SecretStore` → construct the openai-compatible client for the kernel.
- **Persistence**: `AgentSessionStore` (new, `@everdict/db`) — `everdict_agent_sessions` + `everdict_agent_messages`
  (migration `0066`), workspace-scoped, modeled on `RunStore`/`CommentStore`.
- **Composition root** `main.ts` modeled on `apps/api/src/main.ts` (env → stores → services → `buildServer` → listen).

### `apps/web` — the panel

`widgets/infra-panel`: add `'agent'` to the `InfraTab` union (`model/infra-panel-context.tsx`), a rail entry
(`ui/infra-rail.tsx` `TABS`), `TAB_META` + a render branch (`ui/infra-panel.tsx`) → embedded `<AgentChatPanel/>`.
New `entities/agent-session` (zod) + `features/agent-chat` (session list + chat view + input; polling hooks like
`widgets/live-logs`). BFF proxy `app/api/agent/*` → `apps/agent` (`AGENT_URL` env) via `shared/lib/control-plane.ts`.
i18n `agentChat` namespace in `messages/{en,ko}.json`.

## Phased roadmap

- **P0** — this doc + `packages/agent-runtime` scaffold. ✅
- **P1** — port the kernel into `packages/agent-runtime` (loop/llm/context/tools/mcp), unit-tested. ✅
- **P2** — `AgentSession` contracts + `AgentSessionStore` (InMemory/Pg + migration 0066). ✅
- **P3** — `apps/agent` server: `/me` identity, session/message routes, chat loop, MCP read-only tool bridge, model binding. ✅
- **P4** — web: infra-panel `agent` tab + `features/agent-chat` + BFF proxy (`/api/agent/*`, `AGENT_URL`) + i18n. ✅
- **P5** — automated gates green (turbo typecheck+test 70/70 · cone · web-imports · web build). ✅
  *Remaining: LIVE e2e against a running stack + a registered workspace model; dev `up.sh` wiring; `ci:local` before push.*
- **P6 (post-v1 polish, landed)** — session **delete** UI; **live tool activity**: the loop persists each
  assistant/tool turn as it is produced (`onMessage`) and the web polls `/messages?since=` during a turn, so tool
  calls/results show live (collapsible rows) rather than only after the turn settles. **Gap pass** vs digo-agent +
  `workspaces/claude-code` — fixed: tool-only assistant `content:null` (not `""`, which some providers reject),
  `produced` accumulated on append (compaction-safe, not a tail slice), transient upstream **retry** (429/5xx/network,
  same model, fixed backoff), tool-output cap 24k→48k chars. (Assessed-but-not-a-bug for this loop's control flow:
  abort/budget dangling tool_calls — every exit point leaves a balanced transcript; system-anchor loss — the system
  prompt is re-added each turn, never stored in the compacted array.)
- **P7 (frontier-grade UI redesign, landed)** — the panel was rebuilt to a Claude/ChatGPT-desktop bar: assistant
  turns render markdown (`shared/ui/Markdown`) in full-width role rows (an indigo "spark" `AgentAvatar`, not a
  robot); tool calls are collapsible cards (`JsonView`); hover actions (copy / regenerate) with toasts; an
  auto-grow composer with a Stop button, `@`-mention, and `Kbd` hints; a suggested-prompt empty state; smart
  auto-scroll + a scroll-to-bottom pill; date-grouped history with relative time; delete via a styled `Dialog`;
  tasteful `animate-in` motion — all in everdict's design-system atoms/tokens.
- **P8 (real-time + rename + attachments, landed)** — a turn **streams over SSE** (content-negotiated on the chat
  route, `reply.hijack`): `delta` events grow a live assistant bubble, `message` events merge each persisted
  record; the Stop button aborts the request → the server aborts the loop (`req.raw` close). **Session rename**
  (`PATCH /agent/sessions/:id` + inline UI). **File attachments** — text files (paperclip / drag-drop) are read
  client-side and folded into the model context (like @-references); only metadata (name/type/size) is persisted
  (`AgentAttachment`, migration 0068).
- **P9 (per-workspace customization, landed — Phase 1)** — each workspace can enhance its own agent, plugging its
  context + tools into the shared framework the way Claude Code takes a per-project CLAUDE.md + MCP servers. A new
  **registered, versioned `AgentSpec` entity** (`(tenant, id, version) → AgentSpec`, same immutable-version SSOT as
  harness/judge/model: owner-first + `_shared` fallback, soft-delete tombstones) carries three channels:
  **`instructions`** (appended to the base system prompt — persona + tool protocol stay fixed), **`mcpServers[]`**
  (workspace MCP tool servers connected alongside the built-in read-only tools; `authSecret` names a SecretStore key
  resolved to a verbatim `Authorization` value at connect time; **`write` is a per-server opt-in** — the built-in
  Everdict tools stay read-only, a workspace's own server MAY mutate), and a **`model`** override (which registered
  model powers the agent). **Skills are Phase 2.** Surfaces: `POST/GET /agents` + `PUT /agents/:id` (save-upsert,
  auto version-bump) + `DELETE …` + `POST /agents/validate`, with MCP parity (`list_/get_/create_/validate_/delete_agent`;
  `save_agent` stays HTTP-only, mirroring `save_model`); authz `agents:read` (viewer+) / `agents:write` (member+) /
  `agents:delete` (admin, creator exception in the service). The agent server resolves `(workspace, AGENT_CONFIG_ID
  ["default"])` → an `AgentProfile` per turn (`apps/agent/src/profile.ts`): base prompt + instructions, the workspace
  MCP servers (secrets resolved, read-only unless write), and the model override; an unregistered workspace gets the
  base agent unchanged. Web: **Settings › Agent** (`features/manage-agent`) edits the workspace's default agent
  (instructions · MCP servers with a `SecretPicker` authSecret + write toggle · model picker). Migration `0070`.
- **P10 (workspace Skills, landed — the members author them, not imported)** — a workspace builds up its own library
  of **SKILL.md-style procedures** the agent follows for recurring tasks (scorecard-triage, harness-review, …), the
  third Claude-Code channel (context ✓ · tools ✓ · **skills**). Decisions: skills are **authored in-workspace** (not a
  filesystem port), **instructions-only** (v1 — no executable code; actions come from MCP tools), generation lives in a
  **web wizard**, and sharing is **private → workspace** (`visibility private|workspace`, the Views/browser-profile
  pattern — a member drafts privately then "shares to the workspace", managed creator-or-admin). A store-backed `Skill`
  entity (`SkillRecord` {name, description, instructions, visibility, createdBy}; `SkillStore` InMemory/Pg, migration
  `0071`; `SkillService` with the per-visibility gate) — NOT versioned (skills are living docs, edited in place, unlike
  the immutable AgentSpec/Model). Surfaces: `POST/GET /skills` + `PATCH` (edit / share = visibility toggle) + `DELETE`
  + `POST /skills/generate` (**skill-generate** — a description + a registered model id → an AI-drafted
  {name, description, instructions} via the workspace's model + key, reusing the model-probe connection resolution; the
  draft persists nothing), with MCP parity for CRUD (`list_/get_/create_/update_/delete_skill`; generate stays
  HTTP-only, an interactive flow). authz `skills:read` (viewer+) / `skills:write` (member+, creator-or-admin per skill
  in the service). The agent consumes skills via **progressive disclosure**: a native `use_skill` tool
  (`@everdict/agent-runtime` `buildSkillTool`) lists every available skill (name + when-to-use) in its description and
  returns the chosen skill's full body on call; the profile resolver loads the caller's visible skills
  (workspace-shared + own private) each turn, independent of the AgentSpec. Web: **Settings › Skills**
  (`features/manage-skills`) — the library list + a New-skill dialog with an AI generate wizard (describe → draft →
  edit → save) + a private↔workspace share toggle + delete (creator-or-admin).
- **Later** — write-action tools behind HITL (port `permissions`); executable (scripted) skills;
  autonomous scheduled sweeps (runtime monitor → propose/trigger evals); findings → comments + Mattermost;
  SSE token streaming (replace polling); a fallback model + prompt caching; parallel independent tool calls.

## Running it (dev)

```
# 1. apps/api (control plane) running with a workspace + a registered model (D3), e.g. via the dev stack.
# 2. apps/agent:
CONTROL_PLANE_URL=http://127.0.0.1:8787 \
EVERDICT_MCP_URL=http://127.0.0.1:8787/mcp \
DATABASE_URL=postgres://…       # shared with apps/api (sessions + secrets + model registry)
EVERDICT_SECRETS_KEY=…          # same KEK as apps/api (to decrypt the model's API key)
AGENT_MODEL=<registered-model-id> \
PORT=8790 \
  node apps/agent/dist/main.js
# Dev without a DB / registered model: drop DATABASE_URL/AGENT_MODEL and set
#   AGENT_LLM_BASE_URL + AGENT_LLM_API_KEY + AGENT_LLM_MODEL (an OpenAI-compatible endpoint) instead.
# 3. apps/web: set AGENT_URL=http://127.0.0.1:8790 → the infra panel's Bot tab shows conversations.
```

## Verification

- Unit: kernel loop with a fake LLM + fake tool (turn/stop-reason/tool-dispatch); ToolSearch discovery; compaction
  threshold. `AgentSessionStore` in-memory + fake `SqlClient`. `apps/agent` via `buildServer`+`inject`.
- E2E: with `apps/api` + a workspace model + a read-only `ak_` key, create a session and ask "summarize my last
  scorecard's failures" → agent calls `list_scorecards`/`get_scorecard`/`inspect_trace` over MCP → assistant
  messages stream into the web right-panel `agent` tab.
