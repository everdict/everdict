---
kind: wiki
title: "Agent conversations — a conversational, multi-turn agent over the eval control plane"
status: current
updated: 2026-08-11
anchors: [packages/domain/src/model/model-binding.ts, packages/self-hosted-runner/src/runner-session.ts, apps/api/src/main.ts, apps/agent/src/live-turns.ts]
---
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
  `packages/domain/src/model/model-binding.ts`). The tenant's key is used and cost is attributed to them.
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
`digo-agent/src/runtime/*` (its kernel map is faithful to Claude Code):

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
  record. **Session rename** (`PATCH /agent/sessions/:id` + inline UI). **File attachments** — text files
  (paperclip / drag-drop) are read client-side and folded into the model context (like @-references); only
  metadata (name/type/size) is persisted (`AgentAttachment`, migration 0068).
- **Live turns are decoupled from the connection** (`apps/agent/src/live-turns.ts`) — the original P8 coupling
  ("client disconnect aborts the loop") made switching conversations kill or orphan a running turn: the panel
  looked idle on return and a re-send double-ran the session. Now POST /chat registers the turn in a per-session
  **LiveTurnRegistry** and the SSE response is just its first subscriber: a disconnect only detaches (the loop
  keeps running headless, records keep persisting), a concurrent /chat on the same session is refused with
  **409** (the duplicate-turn guard), **`GET /agent/sessions/:id/stream`** re-attaches (204 when idle; replays
  the in-flight assistant/reasoning buffers + parked HITL asks, then follows the broadcast to the terminal
  done/error), and **`POST /agent/sessions/:id/stop`** is the explicit abort the Stop button now calls. Session
  responses carry a computed **`live`** flag (wire-only, `AgentSessionResponseSchema` — never persisted): the
  history menu shows a running badge, and the panel auto-re-attaches when it opens a live session (a send that
  409s restores the input and re-attaches instead of erroring). A parked write-tool approval survives navigation
  — deny now comes only from timeout or /stop, and the re-attach replay re-renders the prompt.
- **Long-run resilience (landed — the "frequent disconnects" hardening, gap-analyzed file-by-file against
  `workspaces/claude-code`)** — four layers. (1) **Transport senses** (`@everdict/llm`, Anthropic): `timeoutMs` is
  actually enforced (time-to-headers; it was declared and unused), a **90s stream-idle watchdog** cancels a
  silently-dead SSE body (a dropped connection must not pin the turn forever), a stream that ends with no
  content/tool_calls/stop_reason fails as a retryable error instead of posing as a completed empty turn, and a
  rate-limited response surfaces `Retry-After`/`anthropic-ratelimit-unified-reset` as `extra.retryAfterMs`. The
  **OpenAI-compatible transport remaps too** (it used to let the raw SDK `APIError` through): status +
  `retryAfterMs` in `extra` for the retry policy to classify on, the parsed response BODY in the message — a 429
  that says `usage_limit_reached … resets_in_seconds` is the member's whole diagnosis.
  (2) **Retry policy** (kernel `runAgentLoop`): exponential backoff + jitter (500ms base → 32s cap, default 6
  retries — was 2 fixed), the server's own pacing honored over the computed backoff, retryability decided by the
  TRUE upstream status (`extra.status` — a provider 400 is no longer retried just because UpstreamError maps to
  502), `retry` events surfaced per wait, and **`persistentRetry`** for unattended turns (teammate / discussion /
  report set it via a deps spread): capacity errors (429/529/overloaded) are waited out indefinitely (5min-cap
  backoff) instead of failing the reaction. An ATTENDED turn does the opposite past
  `INTERACTIVE_RETRY_AFTER_MAX_MS` (30s): a server pacing longer than a person can wait ends the turn
  immediately — a plan quota that resets in hours/days is not something backoff fixes, and parking the chat behind
  a retry banner for it is the failure, not the recovery. The thrown `UpstreamError` carries the provider's own
  reason in its MESSAGE (not only in `extra.detail`): "the model provider call failed" alone cannot be told apart
  from a dead key, an exhausted quota or a network blip, and it is the string the member reads. (3) **Transcript repair** (`normalizeHistory` — Claude Code's
  `ensureToolResultPairing` reinterpreted): a crash-dangling assistant `tool_calls` is answered with a synthetic
  tool result on replay and orphan tool results are dropped, so a mid-turn host death no longer bricks the
  conversation with provider 400s forever. (4) **Failure is a conversation citizen** (`runChat`): a failed turn
  persists WHY as an assistant record before rethrowing (the transcript shows it; the next message just
  continues) — for the WHOLE turn, not just the loop, so one that dies before the first model call (no model
  configured, an unreachable model registry, a dead tool session) can no longer read as the agent ignoring the
  member — and the same cause is `console.error`-logged for the operator (a turn that died on the provider used to
  leave no trace at all in the service log). Usage metering moved to a `finally` (a failed/aborted turn's consumed tokens still bill), and the
  chat MCP invoke now **reconnects a dead session** (`makeInvoke` over a client box; shared in-flight reconnect —
  reads auto-retry once on the fresh session, mutations return an explicit outcome-unknown error instead of
  risking a silent double-fire). Also in this pass: a turn's write tools run **serially in call order** while
  consecutive read-only calls stay concurrent (the isConcurrencySafe partition, over `isReadOnly`); the default
  output cap rose 4096→8192 with `finishReason` truncation surfaced as a `truncated` event; `outputTokens` is a
  loop/stream option end-to-end. The panel RENDERS the resilience: `retry`/`fallback` flow through the SSE feed
  (the live-turn snapshot replays an in-progress wait to re-attachers) as an amber notice, so a minutes-long
  backoff reads as "waiting out a capacity limit, attempt N" instead of a frozen turn. And the permission-mode
  picker applies MID-TURN: the permit hook re-reads the session's mode per ask (an explicit per-turn body.mode
  still pins the whole turn; plan stays turn-scoped), and PATCHing the mode resolves already-parked asks the new
  mode would never have asked (bypass → all, auto → the non-guarded).
- **Gap round 2 — unwired assets (landed)**: the second claude-code parity pass found the loop itself at parity
  and the gaps OUTSIDE it — mostly existing everdict assets never wired into the conversation. Three wirings +
  one kernel addition: (1) **knowledge auto-recall** — a turn carrying @-references asks `get_task_context` ONCE
  with the references mapped to knowledge-node refs (the reference IS the anchor; its version IS the as-of
  coordinate) and folds the workspace's claims/decisions/conventions into the preamble (Claude Code's
  relevant_memories, reinterpreted as anchored recall instead of embedding search; best-effort, no-reference
  turns recall nothing). (2) **Crafted agents as spawnable sub-agent types** — `registrySubagentTypes` maps the
  workspace's registered agents (instructions = role prompt) into `spawn_agent(subagent_type)` roles, merged
  after the builtins (name collision keeps the builtin; the chat's own config agent excluded; tools stay the
  read-only sub-agent surface; model tier defers to subagentModel). (3) A **`verify` builtin sub-agent type** —
  Claude Code's verification agent reinterpreted: refute-first, verdicts must cite read-tool outputs, and the
  read-only toolset is framed as the verifier's qualification. (4) **Structured output** (kernel): `outputSchema`
  registers a `structured_output` tool whose parameters ARE the schema; the submission ends the run with the
  value on `AgentLoopResult.structuredOutput` (one nudge if the model finishes without submitting) — for
  programmatic hosts (activations, reactions, evals). (5) **Session running memory** (Claude Code's session
  memory reinterpreted; mig 0101): `AgentSessionRecord.memory` + `memoryThroughSeq` hold a rolling digest of the
  conversation's oldest records, maintained by `maintainSessionMemory` at successful turn boundaries — once the
  bounded replay span outgrows ~100k chars, the records beyond the recent-20 working set are folded (cut at a
  clean USER boundary so the tail replays balanced) into a fresh digest SEEDED with the previous one (memory only
  rolls forward; a declining summariser keeps full replay). The next turn replays digest + uncovered tail instead
  of the whole history — a long conversation stops re-reading (and re-compacting) its entire past every turn.
  In-run compaction is unchanged and complementary: compaction fits ONE run's context; memory bounds what every
  FUTURE turn replays. (6) **Stale-file reminders** (`staleFileReminder` — Claude Code's `edited_text_file`
  attachment reinterpreted over the revision ledger): at the turn boundary, the files this conversation touched
  (get_file/write_file calls in the replayed transcript, most-recent 8) are checked against the ledger's newest
  revision (`list_file_revisions` limit 1, parallel, best-effort); a revision published AFTER the conversation's
  last touch by someone ELSE — a member, or an agent in ANOTHER conversation (`actor.conversationId` decides) —
  earns a preamble warning naming who/when/why, so the agent re-reads before relying on or overwriting stale
  knowledge. The mid-conversation counterpart of the write path's 409 + three-way merge; zero ledger calls for
  conversations that never touched a file. (7) **Soft interrupt** (kernel + seam; Claude Code's ESC
  reinterpreted): `onInterruptReady` hands the host a trigger that aborts only the IN-FLIGHT step — each model
  attempt and the whole tool dispatch run under a per-step AbortController linked to the run signal, and a retry
  wait breaks early. An interrupted model call appends nothing (balanced); an interrupted tool batch closes its
  pairing with synthetic results (settled tools keep their real result; in-flight → outcome-unknown error;
  never-started → not-executed). Resolution at the now-balanced boundary: queued input (drainInput) → the turn
  continues REDIRECTED; nothing queued → stopReason `interrupted` (stop and wait for the user — a bare ESC).
  `LiveTurnRegistry.setInterrupt/interrupt` parks the trigger per turn (stop() stays the whole-turn abort);
  ChatHooks.onInterruptReady forwards it. REMAINING WIRING (blocked on the concurrent server.ts run-ledger
  refactor): the chat route passing `onInterruptReady: (fn) => liveTurns.setInterrupt(ws, id, fn)`, a
  `POST /agent/sessions/:id/interrupt` route (visibility-aware like /stop), and the web's queue-then-interrupt
  composer flow (POST /input then /interrupt while a turn is live). (8) **Agent-plane metrics**
  (`ChatDeps.metrics` → the shared zero-dep Prometheus registry, exposed as GET /metrics on the agent server by
  main.ts): the loop's resilience events become measured series — `everdict_agent_turn_total{outcome}` (incl. a
  thrown turn as outcome="error"), `everdict_agent_turn_seconds` (success or not), `everdict_agent_retry_total
  {persistent}`, `everdict_agent_fallback_total`, `everdict_agent_truncated_total`,
  `everdict_agent_compaction_total{mode}`, `everdict_agent_tool_result_total{ok}` — so "why do turns die" is a
  distribution you scrape, not an anecdote (the measurement gate the gap analysis put BEFORE streaming tool
  execution). Deferred from the same analysis: task ledger (agent-teams), streaming tool execution (deliberately
  last — Claude Code's inc-4258 double-execution scar interacts with our non-streaming retry ladder).
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
  entity (`SkillRecord` {name, description, instructions, **files**, visibility, createdBy}; `SkillStore` InMemory/Pg,
  migrations `0071` + `0080`; `SkillService` with the per-visibility gate) — NOT versioned (skills are living docs,
  edited in place, unlike the immutable AgentSpec/Model). Surfaces: `POST/GET /skills` (+ `GET /skills/:id`) + `PATCH`
  (edit / share = visibility toggle; `files` replaces the whole set when present, omitted = kept) + `DELETE`
  + `POST /skills/generate` (**skill-generate** — a description + a registered model id → an AI-drafted
  {name, description, instructions, files} via the workspace's model + key, reusing the model-probe connection
  resolution; the draft persists nothing), with MCP parity for CRUD (`list_/get_/create_/update_/delete_skill`;
  generate stays HTTP-only, an interactive flow). authz `skills:read` (viewer+) / `skills:write` (member+,
  creator-or-admin per skill in the service).
  **A skill is NOT one giant document** (the Claude Code skill-directory reinterpretation): the SKILL.md body
  (`instructions`) stays a lean procedure, and long reference material lives in `files` [{path, content}] — relative
  forward-slash paths, no traversal, ≤32 files × ≤256 KiB, unique paths (contract-validated). The agent consumes
  skills via **three-tier progressive disclosure** (`@everdict/agent-runtime` `buildSkillTools`): (1) the `use_skill`
  tool description lists every skill (name + when-to-use) under a Claude-Code-parity listing budget (250 chars/entry,
  8 000-char budget, even shrink → names-only floor — a skill is never dropped from the listing); (2) `use_skill(name)`
  returns the body plus a paths+sizes **index** of its files; (3) `read_skill_file(skill, path)` loads exactly one
  file at the step that needs it (the tool exists only when some skill bundles files). Loaded-skill payloads survive
  microcompact within a 24 k-char budget, newest first (Claude Code's post-compact skill re-emission, reinterpreted) —
  an agent mid-procedure does not lose its instructions. The profile resolver loads the caller's visible skills
  (workspace-shared + own private) each turn, independent of the AgentSpec; capability-store skill specs
  (`SkillCapabilitySpec`) carry the same optional `files`. Web: **Settings › Skills** (`features/manage-skills`) — the
  list grouped **Personal drafts / Workspace skills** + a New-skill dialog with an AI generate wizard (describe →
  draft [may include files] → edit → save) + a private↔workspace share toggle + delete (creator-or-admin), and a
  **detail page** `settings/skills/[id]` (`SkillDetail`): SKILL.md + per-file tabs (markdown rendered, others mono),
  meta strip, and **"Edit with agent"** as the primary editing path — `AskAgentButton` (widgets/infra-panel) opens the
  right-hand agent chat panel with the skill @-referenced (`skill` is an `AGENT_REFERENCE_TYPES` member, resolved via
  `get_skill`) and a draft prompt pre-typed (`askAgent(prompt, ref)` on the panel context; nothing auto-sends), so the
  agent reviews and applies edits through `get_skill`/`update_skill` under the conversation's permission mode (HITL).
  The manual editor dialog stays as the secondary path (files are listed/removable there; file content authoring is
  the agent's job).
- **P8 — a workspace's configured integrations are usable by default (HITL-gated).** Beyond the read-only
  allowlist, the agent bridges a curated set of **"use the integration" actions** from the base control-plane
  surface by DEFAULT (`apps/agent/src/mcp-tools.ts` `INTEGRATION_ACTIONS`): `post_mattermost_message` (new — post
  to the workspace's configured channel), `open_ci_setup_pr`, `get_image_push_credentials`. Each is bridged
  `isReadOnly:false`, so the existing HITL permission gate approves every call inline. Deliberately narrow —
  config/register/destroy (`set_/probe_/remove_/assign_/link_/start_`) and secret writes stay excluded, so
  default-deny still holds for every other mutating verb. This removes the friction of an admin hand-registering a
  `write:true` `AgentSpec.mcpServers` entry just to let the agent act on integrations the workspace already set up.
  `post_mattermost_message` is a new control-plane capability (route + MCP tool + `mattermost:post` member action)
  over `MattermostService.postMessage` — the one genuine gap, since posting to Mattermost previously existed only
  as the internal completion-notification path.
- **P11 (reasoning + grouped tool activity, landed)** — the transcript now renders the agent's *thinking* and folds
  the noise. **Reasoning end-to-end**: `@everdict/llm` captures a turn's reasoning on both providers — Anthropic
  `thinking`/`redacted_thinking` blocks (streamed `thinking_delta`/`signature_delta`) and OpenAI-compatible
  `reasoning_content` — and returns it as `StreamResult.reasoning` (display text) + `reasoningBlocks` (native blocks).
  Extended thinking is opt-in: `StreamRequest.thinking={budgetTokens}` (wired through the loop's `thinking` option and
  the agent's `AGENT_THINKING_BUDGET` env) enables Anthropic thinking, bumps `max_tokens` above the budget, and drops
  `temperature` (Anthropic rejects a non-default temperature with thinking); reasoning models reason regardless, so
  capture is always on. The kernel attaches the reasoning to the assistant message as a **side-channel**
  (`ReasoningCarrier`): the display `text` is persisted (`AgentMessageRecord.reasoning`, migration `0074`) and the
  native `blocks` are re-sent verbatim on the following tool-result call so Anthropic's "preserve the thinking block
  when tool_use follows thinking" holds within a turn (the OpenAI transport strips the side-channel — stateless). The
  loop emits `reasoning_delta` events → SSE `reasoning` → a live, foldable **ReasoningBlock** in the panel. **Grouped
  activity (web)**: `buildTranscript` folds the flat message list into render items — assistant text + user turns are
  role rows; a run of consecutive tool calls collapses into ONE `ToolGroup` ("Used N tools", one click to expand); a
  `write_todos` call surfaces as a dedicated **TodoList** checklist (plan / progress) instead of a raw tool card;
  reasoning is its own block. Tool cards no longer repeat the avatar per turn, so a long tool-heavy turn stays compact.
- **P12 (analysis artifacts, landed — backend)** — the agent emits **durable, declarative artifacts**
  (chart/table/report) instead of ephemeral chat text: native per-turn emission tools
  (`apps/agent/src/artifact-tools.ts` — `render_chart`/`render_table`/`write_report`, spec-validated via
  `@everdict/contracts` `parseAnalysisArtifactSpec`, `isReadOnly:true` per the write_todos precedent),
  persisted on the conversation (`AnalysisArtifactStore`, mig 0077), streamed live (SSE `artifact`) and
  listable (`GET /agent/sessions/:id/artifacts`). Never active content (no HTML/JS). Web rendering + View
  pinning land with the Analysis Studio — see `docs/architecture/analysis-studio.md` (the SSOT for this direction).
- **P13 (bridge-all mutations + permission modes, landed)** — the agent can act on EVERY everdict entity: the base
  surface is the whole control-plane MCP catalog (mutations included — `run_scorecard`, `create_dataset`,
  `register_harness`, `delete_*`, `set_workspace_*`, …), with only the runner wire-protocol tools excluded
  (`apps/agent/src/action-policy.ts` `isProtocolTool`). This SUPERSEDES both the default-deny read allowlist framing
  and the `AGENT_ALLOW_EVAL_DRIVE` opt-in (P8's curated `INTEGRATION_ACTIONS` survives only as the classification
  that keeps a minting `get_` read HITL-gated). Safety is layered, not surface-shaped: the control-plane **RBAC**
  bounds every call to the member's role, and every mutation goes through the permission gate under the session's
  **permission mode** — `default` (ask every mutation) · `auto` (auto-allow routine mutations, ask only the GUARDED
  destructive/governance/credential actions — `isGuardedAction`) · `bypass` (never ask — the member's explicit
  standing choice; session rules are skipped too) · `plan` (read-only until the presented plan is approved). The
  mode is a first-class session field (`AgentSessionRecord.permissionMode`, mig 0079) picked in the chat header
  (next to the model picker; a draft's pick rides the lazy session create), resolved per turn as
  `body.mode ?? session.permissionMode ?? "default"` (an explicit body.mode is a one-off override), and the
  existing session rules ("always allow/deny this tool") still short-circuit the prompt in default/auto.
- **Later** — executable (scripted) skills; autonomous scheduled sweeps (runtime monitor → propose/trigger evals);
  findings → comments + Mattermost; a fallback model + prompt caching; parallel independent tool calls.

## Discussion bridge — @everdict inside a comment thread

Every entity detail screen's comment thread (`features/discuss`) doubles as a **multi-party chat room with the
agent**: a member mentions `@everdict` in a comment and the agent answers **in the thread**, reading the whole
discussion as context. The raw transcript would swamp a discussion, so the agent comment renders compactly —
a live "doing now" line while it works, then only the final markdown answer — and the full reasoning/tool
transcript opens on demand in the right panel (the normal conversation view), where any member can continue
chatting 1:1.

- **An agent's comment is Everdict's, wherever it came from.** The bridge is not the only way an agent ends up in
  a thread — a triage/crafted agent posts through `create_comment` (MCP) or `POST /comments`, and it does so with
  the MEMBER'S own credential, because apps/agent is a token courier. The authenticated subject therefore signed a
  member's name to words they never wrote. The caller instead **declares** the agent in the request (the
  `x-everdict-agent-id`/`-name`/`-conversation-id` headers the workspace filesystem's revision ledger already
  reads — `fs-actor.ts`; MCP reads them once at initialize), and `CommentService.create` authors the row as
  `COMMENT_AGENT_AUTHOR` with `agentSessionId` = that conversation, so the thread shows Everdict with a way back
  to the reasoning. It is born `complete` (a tool caller already has its answer — no lifecycle to drive). Two
  consequences follow from the same sentinel: the comment emits **no** `comment.created` fact (loop guard #1 — a
  watching agent must never wake on its own answer), and `askAgent` from a declared agent is a **400** rather than
  a turn fired on its own comment. Attribution, not privilege: the member's token authorizes the write either way,
  so a forged declaration can only mislabel the caller's own comment.
- **Comment row IS the answer.** `CommentRecord` gains `authorKind:'agent'` + `agentStatus`
  (`running → awaiting_approval → complete|failed`) + `agentActivity` (machine token
  `thinking|writing|tool:<name>`, localized by the web) + `agentSessionId` (mig 0082). The control plane stays
  the ONLY comment mutator.
- **Bridge = the report-turn template, detached.** `CommentService.create(askAgent)` (busy-guard: one live turn
  per thread, 409) creates the placeholder and fires the `DiscussionTurnRunner` port → agent
  `POST /internal/discussion-turn` (x-internal-token), which **acks 202 and runs detached** (a HITL park can
  last minutes). `runDiscussionTurn` (apps/agent) mints an `agt_` token AS the asker (`["read","write"]`),
  runs one capped `runChat` over the thread snapshot (+ the resource via the @-reference channel; `schedule`
  has no reference type → thread-only), and reports progress back over
  `POST /internal/comment-activity` (the `/internal/usage` twin) onto the placeholder.
- **The answer stays in the thread it answers.** The placeholder is nested on the ask's anchor
  (`trigger.parentId ?? trigger.id` — only a top-level comment can be a parent), and that `anchorId` rides on the
  `DiscussionTurnRunner` port into the prompt, because the thread snapshot is deliberately id-less: without it the
  agent knows no comment id at all, so any `create_comment` it writes can only land top-level, a second
  conversation beside the one it is in. The prompt therefore forbids re-posting the answer (the turn's final
  message IS the comment) and names the anchor for any comment it does write. The same gap closes on the
  **activation** side: a `comment.*` fact already carries `commentId`/`parentId` in its payload, and
  `renderActivationPrompt` now spends one line telling the woken agent to reply with that parent.
- **One session per thread, reused + workspace-visible.** The thread's session
  (`visibility:'workspace'`, mig 0083, owner = first asker) is reused across asks, so the agent keeps the
  discussion's memory and panel follow-ups. `getVisibleSession` (owner OR workspace) relaxes the session read /
  messages / pending / permission / chat lookups — owner-only stays for list/rename/delete/model/mode.
- **Background HITL.** The turn's `permit` parks in the `PermissionRegistry` (now storing name/input +
  `pendingFor(sessionId)`, longer per-wait timeout) and flips the comment to `awaiting_approval`; a panel opened
  mid-turn discovers the ask via `GET /agent/sessions/:id/pending` and answers through the normal
  `POST .../permission`. In-memory: an agent restart mid-park strands the turn (`finally` → `failed` covers the
  request-severed case).
- **Web.** The composer's `@` menu leads with a synthetic `@everdict` entry (never in `mentions[]` — it flips
  `askAgent`); the thread polls a server action while a turn is live so every viewer sees running → final; the
  agent card's "view details" opens the panel on the session (`openAgentSession` context +
  `everdict:open-agent-session` postMessage), where a **watch mode** polls `/messages?since=` + `/pending`
  (a background turn streams SSE to nobody — `runChat` persists records incrementally by design).

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
