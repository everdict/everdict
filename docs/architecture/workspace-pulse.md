# Workspace pulse — the home screen's one read

> How is this workspace doing, and which way is it moving?

`GET /workspace/pulse?days=30` · MCP `get_workspace_pulse` · web `/{workspace}`

## Why it exists

Everdict's home used to answer one question — "what did we evaluate" — with initiative readiness cards, a
regression list, a scorecard leaderboard and a recent-runs table. Every one of those is a true answer to a
question most people did not arrive with. A workspace here also files issues, runs iterations, chases goals,
keeps agents working and publishes knowledge, and none of that was visible on the screen people open first.

The pulse replaces it with two halves and nothing else:

- **the state right now** — the counts a person scans before deciding what to do;
- **the trend** — the same workspace over the last N days, so "we have 42 open issues" comes with "and that
  number has been falling".

It is deliberately NOT a per-team comparison (user decision, 2026-08-04). A dashboard that stands teams beside
each other becomes a scoreboard, and the question it was built to answer disappears from it.

## Why it is ONE endpoint

The web could assemble this from eight list endpoints. It should not, for two reasons:

1. **The arithmetic is the control plane's.** What counts as an OPEN issue (`regressed` is open — it is work in
   flight), what an active cycle COMMITTED to, which metric is the headline pass rate (`headlinePassRate`, the
   same ranking `caseVerdict` uses), when a goal is AT RISK (somebody reported it; silence is not an alarm) —
   each of those is a domain decision with exactly one right answer. A web that re-derives them is a second
   answer waiting to drift from the first.
2. **A dashboard that fans out gets slower every time the product grows an axis.** The counts come from
   aggregates the stores already answer (`countByGroup`, one grouped query over the event log), never from
   paging records to tally them client-side.

## Where each number comes from

| Band | Source | Note |
| --- | --- | --- |
| `work` | `IssueStore.countByGroup(status)` | scoped to the teams the caller may read |
| `cycles` | `CycleStore.list({open})` + `countByGroup(cycle)` twice (all / open statuses) | commitment and completion from ONE aggregate, so the halves cannot disagree |
| `goals` | `ProjectStore.list` + `InitiativeStore.list({active})` | `atRisk` = posted health `at_risk`/`off_track`; a paused project is still in flight |
| `agents` | `AgentTaskStore` (pending + in progress) · `ApprovalStore({pending})` · the log | |
| `evaluation` | `ScorecardStore.list` (window + preceding window) · the log | `passRate` absent when nothing reported one — never zero |
| `trend.*` | `PlatformEventStore.dailyCounts` | one `(day × kind × outcome)` grouped query |

## The trend is the event log

The platform-event log (`docs/architecture/event-plumbing.md`) is the only place the workspace's history is
written down in one shape, so the series are folded from it:

- **activity** — every fact, split by the four axes (`work` · `evaluation` · `agent` · `knowledge`). The
  kind→axis map lives in `@everdict/contracts` (`activityAxisOf`) and is exhaustive over `PLATFORM_EVENT_KINDS`
  by `satisfies`: a new kind fails the typecheck until somebody says which part of the workspace it is news
  about. A kind a reader does not know is DROPPED, never pooled into a fifth band.
- **flow** — `issue.created` against `issue.status_changed` whose destination is a closed status. That
  destination is why the aggregate carries `outcome` (`payload->>'to'`): counting completions any other way
  means reading every issue's embedded history.
- **quality** — the window's batches by day. A day with no batch has NO pass rate, not a zero — the line
  breaks there, because drawing a gap as zero turns a quiet weekend into a quality cliff.

Two honest limits, both by construction:

- The log is **swept** (EO4 retention, the operator's TTL). The series says what the log holds and never
  extrapolates past its own edge — which is also why the backlog is a COUNT tile rather than a curve: walking
  today's open count backwards through the flow would silently drift once the window outruns retention.
- Days are cut in **UTC** (`AT TIME ZONE 'UTC'` in SQL, not the server's `timezone`), matching the usage
  series, so the two can be read side by side and no reader's bars shift by a day.
- The trend needs a **durable** log. The E0 outbox commits a fact with the write it describes, which the
  Postgres stores do in one CTE — the in-memory stores keep their outbox in a private array instead (dev/test
  inspection), so a `DATABASE_URL`-less deployment records no tracker facts at all and the series show only
  what the emitter seam wrote. The COUNTS are unaffected; they read the aggregates directly.

## Authorization

One gate — `issues:read`. Every action the pulse composes (issues · scorecards · events · agents) is viewer+,
so gating each separately asks the same question five times. Team privacy is applied the same way every other
read applies it: the transport resolves `visibleTeamsFor(principal)` and hands it in; the service never decides
who may see what. Same shape for both transports — the route and the MCP tool call one service.

## Adding to it

- A new state number: add it to `WorkspacePulseSchema`, compute it in `WorkspacePulseService` from a STORE (not
  a peer service — the api-layer rule), and render it. A field with no tile drawing it is removal grounds.
- A new event kind: classify it in `ACTIVITY_AXIS_BY_KIND` (the typecheck will insist) — nothing else needed,
  the series pick it up.
- A new axis: it changes the chart's band count and every locale's label. Four is already the readable limit
  for a stacked series; prefer widening an existing axis's meaning.
