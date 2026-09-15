---
kind: wiki
title: "Agent conversations — a conversational, multi-turn agent over the eval control plane"
status: current
updated: 2026-09-15
anchors: [packages/contracts/src/records/agent-session.ts, apps/agent/src/live-turns.ts, apps/agent/src/mcp-tools.ts, apps/agent/src/discussion-turn.ts, apps/agent/src/config.ts]
---
# Agent conversations — a conversational, multi-turn agent over the eval control plane

> Everdict runs and evaluates *other people's* agent harnesses. This is Everdict's **own** agent: a
> conversational, multi-turn, tool-using LLM agent a workspace member talks to from the web to review harnesses,
> analyze scorecards and judge traces, inspect runtime resources — and act on every Everdict entity under the
> session's permission mode. The "agent" name was freed for it by the earlier `agent → job-runner` rename (the
> dispatched worker is `@everdict/job-runner`).
>
> The agentic loop was ported from `workspaces/digo-data/apps/digo-agent` — a Claude-Code-style runtime (loop +
> context compaction + tool registry with ToolSearch progressive disclosure + MCP bridge). Its domain-agnostic
> kernel became `packages/agent-runtime`, adapted to Everdict conventions (`AppError`, Zod boundaries, no `any`/`!`,
> `.js` ESM imports). Automation beyond chat is in [agent-teams.md](./agent-teams.md) and
> [agent-automation.md](./agent-automation.md); the per-workspace tool/skill library in
> [capability-store.md](./capability-store.md).

## Shape

- **A separate `apps/agent` server.** The loop runs as its own Fastify service, not inside `apps/api`. It reaches
  the control plane as an **MCP client** of `apps/api`'s `/mcp` (Streamable HTTP). The kernel lives in
  `packages/agent-runtime`, so another host stays possible.
- **Workspace model ↔ secret binding.** The agent's LLM uses the workspace's registered model and key through the
  `ModelSpec` registry + `SecretStore` (`modelConnectionEnv` / `modelApiKeySecretName` in
  `packages/domain/src/model/model-binding.ts`), so cost is attributed to the tenant.
- **The whole control-plane catalog, governed by permission modes** (see *Permission modes* below) — not a
  read-only allowlist.
- **Web surface = a right-panel tab.** Conversations are the `agent` tab of the infra split-view panel
  (`apps/web/src/widgets/infra-panel`), an embedded component rather than an iframe page.

```
apps/web (infra-panel 'agent' tab, features/agent-chat)
  │  BFF proxy /api/agent/*  (shared/lib/agent-plane.ts, AGENT_URL; forwards the member's bearer)
  ▼
apps/agent  (Fastify; identity = control plane GET /me with the forwarded bearer)
  │  sessions/messages  ─────────────►  AgentSessionStore (@everdict/db, Pg/InMemory)
  │  chat  ──runs──►  @everdict/agent-runtime  (loop · context · tools · mcp bridge)
  │                        │  LLM   ──►  @everdict/llm native transport (workspace ModelSpec + SecretStore key)
  │                        │  tools ──►  MCP client ──(caller bearer or agt_ token)──►  apps/api /mcp
  ▼
apps/api /mcp  (the same tool surface members and CI use)
```

## `packages/agent-runtime` — the kernel

Depends on `@everdict/contracts`, `@everdict/llm`, `openai` and `zod`.

| area | purpose |
|---|---|
| `kernel/loop.ts` + `kernel/normalize.ts` + `kernel/system-prompt.ts` + `messages.ts` | `runAgentLoop`: LLM call → dispatch tool calls → feed results → repeat until end of turn / max turns / budget / abort; `normalizeHistory` repairs transcripts |
| `@everdict/llm` `LlmTransport` (injected) + `llm/summarize.ts` | **provider-native transport** (Anthropic Messages / OpenAI, with prompt caching) selected by `ModelSpec.provider`; `stream()` for the turn, `complete()` one-shot for compaction. A custom `baseUrl` is the `openai-compatible` escape hatch |
| `context/{token-budget,compaction,media-limits}.ts` | context-window compaction (`microcompact` → LLM summary → structural drop) |
| `tools/{definition,registry,invocation,deferred,tool-search,openai}.ts` | tool contract + registry + **ToolSearch progressive disclosure** (deferred MCP tools stay hidden until discovered) |
| `tools/{spawn-tool,send-message-tool,skill-tool,todo-tool,plan-tool,wait-for-tool,…}.ts` | kernel tools: sub-agents, messaging, skills, `write_todos`, plan mode, waits |
| `mcp/bridge.ts` | bridge MCP tools → `ToolDefinition` (deferred); the transport/session is injected by the host |

## `apps/agent` — the server

- **Auth**: the forwarded bearer (Keycloak JWT, `ak_` key, or an `agt_` execution token for request-less turns —
  [agent-execution-auth.md](./agent-execution-auth.md)) is resolved by the control plane's `GET /me`
  (`apps/agent/src/principal.ts`) → `Principal{subject, workspace, roles}`.
- **Routes** (`apps/agent/src/server.ts`): `POST|GET /agent/sessions`, `GET|PATCH|DELETE /agent/sessions/:id`,
  `GET /agent/sessions/:id/messages` (`?since=`), `POST /agent/sessions/:id/chat`, `GET .../stream`,
  `POST .../stop`, `POST .../interrupt`, `POST .../input`, `POST .../event`, `GET .../pending`,
  `POST .../permission`, `GET|POST .../rules` + `DELETE .../rules/:tool`, `GET .../artifacts`; plus the teammate,
  events, runs, try and `/internal/*` routes described in the automation pages.
- **Tools**: on chat, an MCP session to `EVERDICT_MCP_URL` forwarding the caller's bearer; every catalog tool except
  the runner wire protocol is bridged (`apps/agent/src/mcp-tools.ts`) into the runtime registry, deferred behind
  ToolSearch. `makeInvoke` reconnects a dead session: reads auto-retry once, mutations return an explicit
  outcome-unknown error rather than risk a double fire.
- **LLM**: `AGENT_MODEL` names a registered model (with `DATABASE_URL` + `EVERDICT_SECRETS_KEY`); `AGENT_SMALL_MODEL`
  digests compaction summaries, `AGENT_FALLBACK_MODEL` takes over a run whose main model keeps failing, and
  `AGENT_SUBAGENT_MODEL` powers `spawn_agent` sub-agents.
- **Persistence**: `AgentSessionStore` (`@everdict/db`) — sessions + messages (mig 0066), attachments metadata (0068),
  reasoning (0074), permission mode (0079), session visibility (0083), running memory (0101).
- **Metrics**: `GET /metrics` (Prometheus text) — `everdict_agent_turn_total{outcome}`, `everdict_agent_turn_seconds`,
  `everdict_agent_retry_total{persistent}`, `everdict_agent_fallback_total`, `everdict_agent_truncated_total`,
  `everdict_agent_compaction_total{mode}`, `everdict_agent_tool_result_total{ok}`.

## `apps/web` — the panel

`widgets/infra-panel`: `'agent'` in the `InfraTab` union (`model/infra-panel-context.tsx`), a rail entry
(`ui/infra-rail.tsx` `TABS`), rendering `<AgentChatPanel/>` from `features/agent-chat`. `entities/agent-session`
holds the wire schemas. BFF proxy routes live under `apps/web/src/app/api/agent/`. i18n namespace `agentChat` in
`messages/{en,ko}.json`.

## What a conversation does

### Live turns, decoupled from the connection
A turn **streams over SSE** (content-negotiated on the chat route): `delta` events grow the live assistant bubble,
`message` events merge each persisted record, and `reasoning`, `artifact`, `retry` and `fallback` events render in
place. `POST /chat` registers the turn in a per-session **`LiveTurnRegistry`** (`apps/agent/src/live-turns.ts`) and
the SSE response is only its first subscriber: a disconnect detaches (the loop keeps running and persisting), a
concurrent `/chat` on the same session is refused with **409**, `GET .../stream` re-attaches (204 when idle;
replays in-flight buffers and parked approval asks), and `POST .../stop` is the explicit abort. Session responses
carry a computed, never-persisted `live` flag; the panel auto-re-attaches to a live session. Sessions can be renamed
(`PATCH`) and deleted; text attachments are folded into the model context client-side and only their metadata is
persisted.

**Soft interrupt** (Claude Code's ESC): `POST .../interrupt` aborts only the in-flight step. An interrupted model call
appends nothing; an interrupted tool batch closes its pairing with synthetic results. If input was queued
(`POST .../input`), the turn continues redirected; otherwise it stops with `interrupted`.

### Resilience
- **Transport** (`@everdict/llm`): `timeoutMs` is enforced; a 90 s stream-idle watchdog cancels a silently dead
  body; a stream that ends with no content fails as retryable; rate-limit headers surface as `retryAfterMs`. The
  OpenAI-compatible transport remaps SDK errors with the status and the provider's response body.
- **Retry policy** (`runAgentLoop`): exponential backoff with jitter (500 ms base, 32 s cap, 19 retries by default),
  server pacing honored, retryability decided by the true upstream status. `persistentRetry` (teammate, discussion,
  report and activation turns) waits out capacity errors with up to 5-minute backoff. An attended turn instead ends
  immediately when the server's pacing exceeds `INTERACTIVE_RETRY_AFTER_MAX_MS` (30 s).
- **Transcript repair**: `normalizeHistory` answers a crash-dangling assistant tool call with a synthetic result and
  drops orphan tool results, so a mid-turn host death does not brick the conversation.
- **Failure is a conversation citizen**: a failed turn persists WHY as an assistant record (including failures before
  the first model call) and logs the cause; usage metering runs in a `finally`.
- Write tools run serially in call order; consecutive read-only calls run concurrently. The default output cap is
  8192 tokens, and a truncation surfaces as a `truncated` event.

### Context, memory and recall
- **Compaction** fits one run's context (`packages/agent-runtime/src/context/compaction.ts`); loaded skill payloads
  survive `microcompact` within a 24 000-char budget.
- **Session running memory** bounds what future turns replay: `AgentSessionRecord.memory` + `memoryThroughSeq` hold a
  rolling digest maintained by `maintainSessionMemory` — once the replayed span passes ~100 000 chars, records beyond
  the most recent 20 are folded (cut at a user boundary) into a digest seeded with the previous one.
- **Knowledge auto-recall**: a turn carrying @-references asks `get_task_context` once with those references and folds
  the workspace's claims/decisions/conventions into the preamble; no-reference turns recall nothing.
- **Stale-file reminders** (`staleFileReminder`): files the conversation touched (most recent 8) are checked against
  the revision ledger (`list_file_revisions`); a revision published afterwards by someone else — a member or an
  agent in another conversation — earns a preamble warning.

### Sub-agents and structured output
`spawn_agent` offers builtin `subagent_type`s — `explore`, `analyze`, and `verify` (refute-first; verdicts must cite
read-tool output) — plus the workspace's registered agents via `registrySubagentTypes` (a name collision keeps the
builtin). Sub-agents get the read-only surface and the `AGENT_SUBAGENT_MODEL` tier. Kernel `outputSchema` registers a
`structured_output` tool whose parameters are the schema; its submission ends the run with
`AgentLoopResult.structuredOutput` — used by programmatic hosts (activations, verification).

### Reasoning and the transcript
`@everdict/llm` captures reasoning on both providers (Anthropic thinking blocks, OpenAI-compatible
`reasoning_content`). Extended thinking is opt-in via `AGENT_THINKING_BUDGET`. The kernel carries native blocks as a
side channel (`ReasoningCarrier`) so they are re-sent within a turn; the display text is persisted as
`AgentMessageRecord.reasoning`. On the web, `buildTranscript` (`features/agent-chat/lib/transcript.ts`) folds the flat
records into render items: message rows, foldable reasoning, the `write_todos` checklist, sub-agent/teammate activity
cards, mailbox context, artifacts and delegations. Plain tool calls/results are deliberately not rendered.

### Analysis artifacts
Native per-turn tools in `apps/agent/src/artifact-tools.ts` — `render_chart` / `render_table` / `write_report`,
validated by `parseAnalysisArtifactSpec` — emit durable, declarative artifacts, persisted on the conversation
(`AnalysisArtifactStore`, mig 0077), streamed live (SSE `artifact`) and listed by `GET .../artifacts`. Never active
content. Rendering and View pinning are in [analysis-studio.md](./analysis-studio.md).

### Per-workspace customization
The agent a conversation runs is a registered, versioned `AgentSpec` (mig 0070): `instructions` appended to the base
prompt, workspace `mcpServers[]` (`authSecret` names a SecretStore key; `write` is a per-server opt-in), capabilities,
and a `model` override. `apps/agent/src/profile.ts` resolves `(workspace, AGENT_CONFIG_ID = "default")` — or the
crafted agent a run pins — into an `AgentProfile` per turn; an unregistered workspace gets the base agent. HTTP
`/agents` routes with MCP parity (`list_agents` / `get_agent` / `create_agent` / `validate_agent` / `save_agent` /
`delete_agent`); authz `agents:read` / `agents:write` / `agents:delete`. Web: the agent list at
`/[workspace]/settings/agent`. Workspace **skills** are loaded per turn with three-tier progressive disclosure
(`buildSkillTools`: the `use_skill` listing, `use_skill(name)` for the body + file index, `read_skill_file` for one
file). The skill and tool library itself is described in [capability-store.md](./capability-store.md).

### Permission modes
The base surface is the whole control-plane MCP catalog, mutations included; only the runner wire-protocol tools are
excluded (`isProtocolTool`, `apps/agent/src/action-policy.ts`). The control-plane **RBAC** bounds every call to the
member's role, and every non-read call goes through the permission gate under the session's **permission mode**:
`default` (ask every mutation) · `auto` (auto-allow routine mutations, ask only guarded destructive / governance /
credential actions — `isGuardedAction`, which reads a capability's declared `EffectContract` first) · `bypass` (never
ask) · `plan` (read-only until the presented plan is approved). A read-prefixed tool that mints credentials
(`get_image_push_credentials`) still asks. The mode is `AgentSessionRecord.permissionMode` (mig 0079), picked in the
chat header and resolved per turn as `body.mode ?? session.permissionMode ?? "default"`. Session rules ("always
allow/deny this tool") short-circuit the prompt in `default`/`auto` and survive a restart. The permit hook re-reads
the mode per ask, and PATCHing the mode resolves already-parked asks the new mode would not have asked.

## Discussion bridge — @everdict inside a comment thread

Every entity's comment thread (`features/discuss`) doubles as a **multi-party chat room with the agent**: a member
mentions `@everdict` and the agent answers **in the thread**, reading the discussion as context. The agent comment
renders compactly — a live "doing now" line, then the final markdown answer — and the full transcript opens on demand
in the right panel, where any member can continue 1:1.

- **An agent's comment is Everdict's, wherever it came from.** A crafted agent can also post through `create_comment`
  (MCP) or `POST /comments` with the member's credential. The caller declares the agent in the request
  (`x-everdict-agent-id` / `-name` / `-conversation-id` headers, the same ones the workspace filesystem's revision
  ledger reads — `apps/api/src/api/fs/fs-actor.ts`), and `CommentService.create` authors the row as
  `COMMENT_AGENT_AUTHOR` with `agentSessionId` = that conversation, born `complete`. Such a comment emits **no**
  `comment.created` fact (a watching agent must never wake on its own answer). Attribution, not privilege: the
  member's token authorizes the write either way.
- **The comment row IS the answer.** `CommentRecord` carries `authorKind: "agent"` + `agentStatus`
  (`running | awaiting_approval | complete | failed`) + `agentActivity` (`thinking | writing | tool:<name>`, localized
  by the web) + `agentSessionId` (mig 0082). The control plane stays the only comment mutator.
- **The bridge.** `CommentService.create` with `askAgent` (one live turn per thread, else 409) creates the placeholder
  and fires the `DiscussionTurnRunner` port → the agent's `POST /internal/discussion-turn` (internal token), which acks
  202 and runs detached. `runDiscussionTurn` (`apps/agent/src/discussion-turn.ts`) mints an `agt_` token AS the asker
  (`["read", "write"]`), runs one capped `runChat` over the thread snapshot (+ the resource via the @-reference
  channel), and reports progress over the control plane's `POST /internal/comment-activity`.
- **The answer stays in its thread.** The placeholder nests on the ask's anchor (`trigger.parentId ?? trigger.id`),
  and that `anchorId` rides the `DiscussionTurnRunner` port into the prompt, which forbids re-posting the answer and
  names the anchor for any comment the agent does write.
- **One session per thread, workspace-visible.** The thread's session (`visibility: "workspace"`, owner = first asker)
  is reused across asks. `getVisibleSession` (owner OR workspace) relaxes the session read / messages / pending /
  permission / chat lookups; list/rename/delete/model/mode stay owner-only.
- **Background approvals.** The turn's `permit` parks in the in-process `PermissionRegistry` and flips the comment to
  `awaiting_approval`; a panel opened mid-turn discovers the ask via `GET .../pending` and answers through
  `POST .../permission`. An agent restart mid-park strands the turn (it ends `failed`).
- **Web.** The composer's `@` menu leads with a synthetic `@everdict` entry (it flips `askAgent`, never enters
  `mentions[]`); the thread polls while a turn is live; the agent card's "view details" opens the panel on the session
  (`openAgentSession` + the `everdict:open-agent-session` postMessage), where a watch mode polls
  `/messages?since=` + `/pending`.

## Running it (dev)

```
# 1. apps/api (control plane) running with a workspace + a registered model.
# 2. apps/agent:
CONTROL_PLANE_URL=http://127.0.0.1:8787 \
EVERDICT_MCP_URL=http://127.0.0.1:8787/mcp \
DATABASE_URL=postgres://…       # shared with apps/api (sessions + secrets + model registry)
EVERDICT_SECRETS_KEY=…          # same KEK as apps/api (to decrypt the model's API key)
AGENT_MODEL=<registered-model-id> \
PORT=8790 \
  node apps/agent/dist/main.js
# Without a DB / registered model: drop DATABASE_URL/AGENT_MODEL and set
#   AGENT_LLM_BASE_URL + AGENT_LLM_API_KEY + AGENT_LLM_MODEL (an OpenAI-compatible endpoint) instead.
# 3. apps/web: AGENT_URL=http://127.0.0.1:8790 (the default) → the infra panel's agent tab shows conversations.
```

The full environment is declared in `apps/agent/src/config.ts`.

## Verification

- Unit: the kernel loop with a fake LLM + fake tools (`packages/agent-runtime/src/kernel/loop.test.ts`); compaction
  and token budget; `apps/agent` routes via `buildServer` + `inject` (`apps/agent/src/server.test.ts`); live-turn
  semantics (`apps/agent/src/live-turns.test.ts`).
- E2E: with `apps/api` + a workspace model, create a session and ask "summarize my last scorecard's failures" → the
  agent calls `list_scorecards` / `get_scorecard` / `inspect_trace` over MCP → assistant messages stream into the
  panel's agent tab.
