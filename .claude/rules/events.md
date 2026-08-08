# Platform-event rules (push) — facts from transitions

SSOT: `docs/architecture/event-plumbing.md` (E0 grammar + same-tx outbox · E1 cursor consumers · E2 coverage).

- **A PR that adds a state transition adds its fact — in the same PR.** Any new lifecycle transition (a
  status change, a version registered, a publish, a gate refusal) emits a platform event: through the E0
  outbox (`{patch, facts[]}` transitions + the store's `events` param) when the aggregate store is ours,
  or through the `PlatformEventEmitter.emit` seam (best-effort by contract — never wrap it) for
  adapter-backed state (registries, the workspace fs, knowledge).
- Kinds are a **closed vocabulary**: `<subject>.<verb>`, registered in `PLATFORM_EVENT_KINDS`
  (`@everdict/contracts`) — never emit an ad-hoc string. A kind exists only with a live emit point.
  Trigger-matchable kinds are the separate `TRIGGERABLE_EVENT_KINDS` allowlist (mirrored in
  `apps/web/src/entities/agent-spec` — update both). Facts only, never judgments ("failed", not "flaky").
- **Domain facts carry SEMANTIC DATA ONLY** (`DomainFact` — no `message`, no `recipient`; the excess-property
  check on transition literals enforces it). The one-line `message` and the push `recipient` are the
  application PROJECTOR's (`fact-projection.ts`, applied at the `stampFacts` choke point) — a new kind's
  sentence is a `renderFactMessage` template, never a domain string. The payload must therefore carry every
  value the rendering needs (names, identifiers, titles — not just filterable ids): the projector reads the
  fact, never the aggregate. Application-side emitters (`PlatformEventEmitter` paths) author `PlatformFact`
  with their own message — they ARE the projection layer.
- **A new kind is also CLASSIFIED**: `ACTIVITY_AXIS_BY_KIND` (`contracts/records/workspace-pulse.ts`) says
  which part of the workspace the fact is news about (`work` · `evaluation` · `agent` · `knowledge`), and it
  `satisfies Record<PlatformEventKind, …>` — so the typecheck refuses a kind nobody has placed. That map is
  what the home screen's activity trend draws (`docs/architecture/workspace-pulse.md`); a kind with no axis is
  silently missing from it, which is why the compiler asks instead.
- **Transitions must never be spread**: `{...transition}` typechecks and silently drops both halves
  (`patch` AND `facts`). Destructure explicitly.
- Agent-caused facts stamp `causedBy: agent:<agentId>:<sessionOrConversationId>` — loop guard #1 keys on
  that exact prefix, so an agent never wakes on its own effects.
- **Choke points over call sites**: emit where the state changes ONCE — a store decorator
  (`RevisionedWorkspaceFs`, `withRegisteredFact`), the gate (`admitCausedWork`), the domain transition —
  never per-route/per-tool (that forks BFF↔MCP and misses headless callers).
- `_shared` (seed) writes never emit — boot seeding is not workspace news.
