---
kind: spec
title: "What the runtime supports and the web does not — a counted census"
status: proposed
updated: 2026-09-04
anchors: [apps/web/src/shared/lib/control-plane.ts, apps/web/src/entities/scorecard/model/schema.ts, apps/api/src/api/scorecard/scorecard.routes.ts]
---
# What the runtime supports and the web does not — a counted census

> **Status: proposed.** Nothing here is implemented. This page is the CENSUS and the plan it implies; each
> slice names what it closes and what would show it closed. The counts are the point — "the web is behind"
> ages into nothing, and a counted sweep stays checkable and shows its own expiry when the numbers move.

## Why this page exists

The control plane is the runtime's surface and `apps/web` is a pure HTTP client of it, so every capability
the runtime grows is a capability the web has to be taught separately. Nothing enforces that: no gate asks
whether a route has a caller, and a door nobody opens looks exactly like a door nobody needed.

So the drift is invisible by construction, and it accumulates in one direction — the runtime grows, the web
does not follow. This counts it.

## How the census was taken, and what it cannot see

    227   distinct HTTP routes declared in apps/api
    257   distinct paths apps/web's one client (shared/lib/control-plane.ts) can reach
    343   client methods defined, 315 of them called from a page or widget
    417   MCP tools — the same runtime as the AGENT sees it
    105   web pages

Routes were extracted from every `app.<method>("…")` declaration, client paths from every path literal in
`control-plane.ts` with `${…}` collapsed to a parameter, and the two normalized to one parameter spelling
before diffing. Infrastructure surfaces that were never for a browser — `/internal/*`, `/runner*`, `/mcp`,
OIDC/`.well-known`, health, OTLP `/v1/*`, the installer — are excluded by prefix.

**The first three passes of this were WRONG, in ways worth recording**, because they are the ways this kind
of census lies:

- matching only backticked literals missed every `'/me'`, and reported `/me`, `/members` and `/views` as
  unreachable;
- a character class without parentheses missed `` `/scorecards/${encodeURIComponent(id)}` `` entirely,
  inflating the gap to 100;
- `` `/notifications${qs}` `` normalized to a path segment rather than a query string, so a route the web
  calls on every page read as a gap.

Every surviving candidate was then re-checked against the client by literal prefix. What the method still
cannot see: a route reachable through a Next.js route handler rather than the shared client, and a capability
the web reaches but only from a page a user cannot navigate to. Both would make the count too HIGH, which is
the safer direction for a work plan.

## Axis A — doors the web cannot open: **36**

| domain | routes | what is unreachable |
|---|---:|---|
| `knowledge` | 8 | the whole write side: `extract` · `annotate` · `annotations` · `relate` · `related` · `node` · `subgraph` · `context`. The web reads `/knowledge/graph` and can author nothing |
| `workspace` | 7 | `metrics` · `trace-ingestion` · `trace-thresholds` · `images/mirror` · `images/push-grant` · `mattermost/messages` · the GitHub App `callback` |
| `campaigns` | 6 | the ENTIRE evolution domain — list, get, `builds`, `adopt`, `merge`, `settle`. Five design documents, one control-plane surface, zero web |
| `scorecards` | 3 | `query` · `gate` · `backfill-models` |
| `groups` | 3 | experiments — list, get, `score` |
| `fs` | 2 | `search` · `usage` |
| `checkpoints` | 2 | list and get |
| `approvals` | 2 | the queue and `:id/decide` — a HITL decision an agent can make and a person cannot |
| `environments` | 1 | the environment REGISTRY. Settings has an *adopted-environments* page, which is image adoption — a different thing |
| `bundles` | 1 | `apply` |
| `agents` | 1 | `validate` |

Two of these deserve naming, because they are not "a page is missing":

- **`/scorecards/query` has a client-side TWIN that is called instead.** `computeAnalysis`
  (`@everdict/domain`) and `apps/web/src/features/analyze-scorecards/model/analysis.ts` are one engine
  written twice, the web's own comment says they are kept "in lockstep", and only the copy runs. That is the
  predicate-written-twice shape (protocol L3) at feature scale: the server twin is the one with the data, and
  nothing exercises it.
- **`/approvals/:id/decide` is a human decision only an agent can take.** The approval queue exists for a
  person to approve what an agent proposes, and the person has no door.

## Axis B — what the runtime SERVES that the web never decodes

The web keeps local zod schemas (runtime-decoupled by design, drift-guarded against the contract types), so
a served field it omits is measurable. On the two core records:

**`ScorecardRecord` — 41 contract fields, 32 in the web schema.** Nine of the fifteen missing are internal
and correctly absent (`ownerReplica`, `ownerEpoch`, `publication`, `traceProjectionVersion`, `executionPass`,
`scoringPass`, …). Six are product facts the runtime computes and nobody sees:

    gates            the CI gate decisions recorded on this scorecard — pass/block, and why
    scoring          the scoring revision ledger — which judges, at which versions, when
    executions       the execution revision ledger — which retry replaced which attempt, and why
    world            the execution world cohort (os · drivers · runtimes · images) — a comparison axis
    decision         the decision context a release read
    etaSeconds       how long the batch has left
    kind             scorecard or experiment

**`RunRecord` — 32 contract fields, 23 in the web schema.** The product-meaningful absences:

    lineage · placement · outputs · visibility · class · caseSpec · executionId

This axis has a fresh example: the in-place case retry shipped its ledger, and the web schema decodes
`caseAttempts` only far enough to count attempts. That was deliberate and stated. The six above were not
stated anywhere, which is the difference this census exists to remove.

## What this is NOT

Not an argument that every route needs a page. Several of these are legitimately agent-only or
operator-only, and saying so IS the work — an unbuilt page and a deliberate omission look identical in a
count, and only a decision tells them apart. Slice 0 exists for that reason.

## Slice 0 — decide, before building anything — **Landed**

Each of the 36 read against what its route actually declares. **Seven are not gaps at all**: their caller was
never a browser, and counting them as missing pages was the census being conservative in the safe direction.

### Not a gap — the caller is not a browser (7)

| route | who calls it |
|---|---|
| `/workspace/github-app/callback` | GitHub redirects the browser here and the server handles it. A page would be the bug |
| `/workspace/metrics` | *"Workspace-scoped Prometheus metrics"* — a scrape endpoint |
| `/workspace/images/push-grant` | *"Docker Registry v2 token endpoint (the managed registry's auth realm)"* — the docker client's |
| `/workspace/mattermost/messages` | outbound notification send; the platform calls it, nobody clicks it |
| `/bundles/apply` | *"Apply a bundle (one-shot register)"* — the CLI/GitOps door |
| `/scorecards/backfill-models` | an operator maintenance sweep over historical records — a runbook, not a page |
| `/agents/validate` | *"Dry-run validate an agent spec"* — reachable, but through the craft form's own submit path rather than as a door of its own |

### Build — a person needs it and has no way (29)

| what | routes | why it is a person's job |
|---|---:|---|
| **approvals** | 2 | *"Decide a parked agent mutation."* The queue exists so a HUMAN approves what an agent proposes, and the human has no door. The sharpest case in the census |
| **knowledge authoring** | 8 | `extract` mines a thread for entry candidates (*"a real billable model call"*), and `annotate`/`relate`/`node`/`subgraph`/`context`/`annotations`/`related` are the rest of the write side. The web reads the graph and can author nothing |
| **campaigns** | 6 | open · list · get · log a round · ask the adoption gate · settle. An evolution walk a person cannot see is an experiment nobody can audit, and `adopt`/`settle` are gates — the two acts that most need a human |
| **groups (experiments)** | 3 | *"Run an experiment (ungraded phase-1 group)"* and *"Score a group's runs (phase 2, detached)"*. The two-phase experiment has no surface at all |
| **checkpoints** | 2 | handoff checkpoints and *"an independent verification"* — evidence about agent handoffs, read by people |
| **fs** | 2 | *"Search the workspace filesystem"* and *"Filesystem storage usage"*. There is a `/files` page; it cannot search, and cannot say what it costs |
| **trace config** | 2 | `trace-thresholds` (*"evaluated over every trajectory at seal time"*) and `trace-ingestion` (*"the OTLP door's events/hour quota + retention … overridable per workspace"*) — settings with no settings page |
| **environments** | 1 | the environment REGISTRY. Settings has an *adopted-environments* page, which is image adoption — a different noun. The registry is what makes the world an identity axis |
| **images/mirror** | 1 | *"Copy an external image into this workspace's managed namespace"* — a real user action on the managed store |
| **scorecards/gate** | 1 | the CI gate decision. See slice 1: the RECORD already carries `gates` and the web drops it, so this is the same gap from two directions |
| **scorecards/query** | 1 | slice 2 — it has a twin, which is its own finding |

**29 build + 7 not-a-gap = 36.** No slice below adds to this list; a route that appears later is a new
census, dated separately.

## Slice 1 — the served facts — **Landed**

The cheapest real value in the census: the runtime already computes them, the record already carries them,
and the web threw them away at the schema.

**The repair is a classification, not a list of fields.** The existing guards
(`_recordFieldsOnWire`, `_webFieldsOnWire`) check the fields the web DECLARES against the wire — the wrong
half of the question, because the drift that happens is a field the web never declared at all, and omission
is invisible to an assignability check that only looks at what is present. So every wire field is now
classified, exhaustively, and the compiler holds it:

    SCORECARD_WIRE_FIELD_KIND   satisfies Record<keyof ScorecardResponse, 'product' | 'internal'>
    RUN_WIRE_FIELD_KIND         satisfies Record<keyof RunDetailResponse,  'product' | 'internal' | 'elsewhere'>

`product` means a reader is entitled to it and the web schema must decode it; `internal` is control-plane
machinery (ownership fences, live pass markers, the publication outbox) that a reader of a scorecard is not
reading. A `Pick<WebRecord, ProductField>` beside each map is a compile error naming any product field the
web drops, and `satisfies` refuses a field nobody has classified — so a field added to the record breaks the
web build until someone decides, and `product` is the answer that costs work.

Sixteen fields were then added to the two web schemas: nine on the scorecard (`gates` · `scoring` ·
`executions` · `world` · `decision` · `etaSeconds` · `kind` · `runIds` · `verdictSummary`) and seven on the
run (`lineage` · `placement` · `outputs` · `visibility` · `class` · `executionId` · `webhookUrl`).

**Counterexamples, both driven red.** Dropping a product field fails the build with the field's own name;
adding a wire field with no classification fails with `TS1360`. And a runtime test reads each field back
through the real schema, because zod's default `.strip()` makes an undeclared field vanish SILENTLY — a
schema that declares a field and rejects its real shape is worse than one that omits it, and only a parse
proves the difference.

### Census correction — `caseSpec` was never a gap

The run's `caseSpec` read as missing and is not: `runCaseSpecSchema` decodes it beside `runSchema` in the run
page, deliberately, because the wire's is the whole `EvalCase` and mirroring that contract into the web would
both duplicate it and break `_flatGuard` (which correctly refuses a loose index-signature shape). That is why
the run map has a third value, `elsewhere`: an omission with a named owner is a decision, an omission with
none is the drift the map exists for.

The first attempt did use `z.object({}).passthrough()` for the run's new fields, and `_flatGuard` refused
every one of them — correctly, since a loose shape would let the wire change under the page without the
build noticing. They are spelled out.

## Slice 2 — the analysis twin

Delete the client engine and call `/scorecards/query`, or state why the duplicate is load-bearing (an offline
pivot over an already-loaded list is a real answer). Either way it stops being an accident.

**Counterexample owed**: one query shape produces the same table from both engines — which is exactly the
test that does not exist today, and the reason nobody noticed only one runs.

## Slice 3 — approvals, and the rest of the decided list

`/approvals` + `/approvals/:id/decide` first, because a HITL queue with no human door is the sharpest case in
the census. Then whatever slice 0 marked **build**.

## Slice 4 — the check that keeps it closed

A scanner that fails when a route has no client caller and no declared reason — the shape
`unwired-capabilities` and `gated-doors` already have. It is listed last on purpose: it would be RED on `main`
today, and a gate that lands before its fix teaches people to bypass gates (skill `code-review` says this
about a check it also deferred). It lands with the last slice that makes it green.

## The legacy tests this cleared

The goal that opened this work asked for the counterexamples AND for the tests that had stopped earning
their place. One class showed up while slice 1 was landing, in `packages/db/src/db.test.ts`:

    expect(calls[0]?.params?.[13]).toBe("eval");
    // Column order (mig 0092 tail, re-shifted by 0212 dropping team_id): …

Sixteen assertions pinned a POSITION in the params array — the one thing that is not the fact under test —
and their own comment tracked which migration had last shifted the list. That shape does not fail when a
column moves; it goes quietly WRONG, because the index still exists and now names a different column. It is
the same defect family as the placeholder/param drift that took three stores' INSERTs down, seen from the
test side.

They read by column NAME now, parsed out of the statement the store actually built rather than from an
exported constant — importing the store's private column list would only pin the two copies to each other.
Demonstrated by inserting a column at the front: the name-based assertions follow it, the positional one
that had not been converted fails.

## What would reopen this

- **The counts moving.** They are dated; a sweep that disagrees means the census expired, not that it was
  wrong.
- **A second client.** The census assumes `control-plane.ts` is the web's only door to the runtime. If a
  page starts calling the API directly, the method stops seeing it and the numbers become too high in a way
  nobody notices.
