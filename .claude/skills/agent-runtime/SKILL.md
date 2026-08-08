---
name: agent-runtime
description: The provider-agnostic agent kernel (packages/agent-runtime) — runAgentLoop, ToolDefinition/ToolRegistry, the envelope + consent gates, sub-agents, MCP bridging. Use when editing packages/agent-runtime or the agent kernel's contracts.
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
---
# Agent runtime (the kernel)

`packages/agent-runtime` is the agent LOOP — transport-driven turns over a `ToolRegistry`, with the
ownership-protocol gates enforced per tool call. Depends on `@everdict/contracts` (+ `@everdict/llm`)
ONLY — never `@everdict/domain`; a decision the kernel needs lives in contracts (the `isMeasured`
precedent: `authorizeToolInvocation`, `budgetExhausted`, `effectsRequireConsent`).

## Checklist
1. **The kernel executes decisions, never re-derives them** (foundation conventions: one invariant, one
   owner). The envelope scope gate is `authorizeToolInvocation(tool, envelope)` — reads check
   `scope.reads` ("all" = executor posture), writes check `scope.writes`, `forbidden` beats both; the loop
   consumes the answer verbatim. Do NOT add a kernel-side interpretation of the scope (that is exactly how
   `allowedCapabilities` silently narrowed to writes-only once).
2. **Kernel cognition tools are `intrinsic`** (todo, plan, spawn, result paging, wait): part of how the
   agent thinks, exempt from reads/writes scope, still refusable via `forbidden`. Mark them with the
   `intrinsic(...)` wrapper at registry merge — a workspace capability is NEVER intrinsic.
3. **readOnly ≠ safe-without-consent.** The permission hook fires for writes OR for a read whose declared
   `effects` require consent (`effectsRequireConsent` — external egress is exfiltration-shaped). Plain
   reads stay ungated (the senses). `PermissionRequest.isReadOnly` carries the REAL access kind.
   **A base tool's access is DECLARED, not inferred**: every control-plane MCP handler gates on an Action
   string, and registration surfaces it as `annotations.readOnlyHint` — the agent bridge consumes the
   declaration first (`baseToolReadOnly`) and the name-prefix classifier is the compatibility FALLBACK only
   (the minting-read blacklist is the standing proof names carry no authority). External workspace servers'
   annotations are self-claims and are NOT trusted for gate-skipping.
   **An UNDECLARED remote MCP read is not a plain read**: the transport being an external endpoint is a
   structural fact, so the bridge synthesizes `{dataAccess: {egress: "external"}}` for a remote read-only
   server with no declaration (`bridgedEffectsFor`, apps/agent mcp-tools) — the author's own declaration
   always wins, stdio (local) servers synthesize nothing.
4. **Sub-agents shrink, never escape**: the child registry = the parent's read-only tools ∩ the parent's
   own scope, and the parent's envelope binds the child verbatim (per-run budgets re-count from zero).
5. **A halt owes a handoff.** `budget_exhausted` (and an armed `waiting`) settle as SUSPENDED — never
   completed; the host publishes the checkpoint and reports the handoff's actual fate
   (published|failed|absent). See docs/architecture/ownership-protocol.md.
6. Tool results feed back as `tool` messages; large results offload through the ResultStore and page via
   `read_tool_result`. MCP-bridged tools default `isReadOnly: true` and validate on the server side.

SSOT: `docs/architecture/ownership-protocol.md` (envelope/checkpoint/effect contracts) +
`docs/architecture/agent-automation.md` (activation) + rule `.claude/rules/events.md` (facts).
