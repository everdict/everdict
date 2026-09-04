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

## Slice 2 — the analysis twin — **Landed**

**The duplicate is load-bearing and stays.** The studio pivots an already-loaded list, and a round trip per
filter toggle would make it unusable — that is a real answer, not an excuse. What was NOT load-bearing was
the lockstep: each engine carried a comment saying the other is kept in step with it, which is a claim about
another component with nothing checking it, and only one of the two is ever called — so a divergence would
have been invisible for as long as nobody used the route.

`fixtures/analysis-parity.json` is the one question both engines answer. Each side has its own test over it,
neither imports the other (the web may not import `@everdict/domain` at all), and the file is read rather
than imported for that reason. Four cases: the case-count weighting that stops a 5-case smoke run
outweighing a 500-case suite, a metric absent from a card contributing NOTHING rather than a zero, `latest`
reading the newest card's own row without falling back, and `count` being metric-independent.

Driven red on each side independently — dropping the weighting in the web engine reddens the web's test
only, and dropping it in the domain reddens the domain's only.

⚠️ **The fixture corrected me before it corrected any engine.** Its `latest` expectation assumed a fallback
to an older card that has the metric. There is none: `latest` takes the newest card and reads ITS row, which
for that group is absent. The expectation was the bug, and the property is now pinned by name.

## Slice 3 — approvals — **Landed**

`/approvals` + `/approvals/:id/decide`, because a human-in-the-loop queue with no human door is the sharpest
case in the census: the control plane parked agent mutations that only the AGENT surface could answer.

`/approvals` is a page, reachable from the palette but with no permanent sidebar row — the same posture the
agent fleet keeps, for the opposite reason: the queue is usually empty, and a row that is empty most days
trains people to stop looking at it. What it must not be is unreachable.

Three decisions the page makes, each with a test:

- **A read that failed is not an empty queue.** Showing "nothing to approve" over an unreadable store tells a
  member no agent is waiting when one is.
- **`requestId` is dropped at the schema.** The control plane's own comment calls it live-delivery
  correlation, never identity; a page that rendered it would be showing plumbing.
- **A decided or expired row keeps its place and loses its buttons.** The queue is a record of what was asked
  and answered, not a worklist that empties. And `expiresAt` is on the row, because not deciding IS a
  decision — an expired approval is denied.

The palette keywords are English-only: it matches on the TRANSLATED label plus keywords, so the `ko` nav
label already finds the row and Korean keywords here would be debt against the language ratchet for nothing.

## Slice 5 — paying the named debt, surface by surface

Slice 4 turned the remaining gaps into debt the gate carries by name. This is the ledger of what has been
paid, and it is the only honest place to read how far the census got: the gate going green does not mean the
surfaces exist, it means each missing one has a line saying so.

| paid | what it closes |
|---|---|
| `/runs/:id/cancel` | a run that will not finish could be WATCHED and not stopped. The control is bound to `queued`/`running`/`suspended` — a settled run's button answers 409 and nothing else, which teaches people the page lies. Tested in both directions, and driven red by unbinding it |
| `/fs/search` | a workspace tree you can browse and cannot search is a tree you have to already know. TWO inputs, not one, because the control plane searches two different things: `glob` matches PATHS and `pattern` greps CONTENT, and collapsing them makes the box lie about what it does. A truncated result says it is a FLOOR |
| `/fs/usage` | …and a tree with no usage read cannot say what it costs. Best-effort on the page: a usage read that fails must not take the browser down, and absent reads as "not measured", never 0 |

| `/harnesses/:id/lineage` · `span-attr-mapping` · `delegate` | a harness page could say what a version IS and nothing about what produced it, what a pulled trace is read AS, or who maintains each slot. Three panels on one card, each distinguishing **unread from empty** — the shared mistake of a best-effort side read is drawing nothing when the read failed, which tells a reader the thing does not exist |
| `/harnesses/:id/pins` | the headless re-pin. Its confirm says what it MAKES rather than asking "are you sure": a re-pin registers a NEW immutable version, and a reader who thinks it edits the current one will use it very differently |
| `/scorecards/:id/verify-manifest` | THREE answers, not two. `unverifiable` is not a failure — it says the check could not run, and collapsing it into "mismatch" accuses a batch nobody read |
| `/scorecards/:id/gate/override` | an override on the RECORD instead of in a conversation. The reason is required; an override that leaves no artifact overrides nothing (rule `suite`). Shown only when there IS a block, which the record's `gates` field (slice 1) is what makes possible |
| `/scorecards/:id/report` | the batch as something a reader takes AWAY. Returned as text rather than re-rendered in our components, which would produce a second document saying almost the same thing |
| `/scorecards/estimate` | what a batch will cost before spending it. Asked on demand, not per keystroke. **No history is a real answer** and says so — printing $0 for a pair nobody has run would be inventing a number the route goes out of its way not to invent |
| `/skills/:id/verify` | the act that turns "true when written" into "checked on a date" |
| `/datasets/:id/versions/:v/attest` | the constitutional approval a `ground_truth` declaration needs. Deliberately not one-click: an approval that costs one click is one nobody read, and the note is recorded against the exact bytes |
| `/judges/:id/versions/:v/tags` | every other versioned entity could be labelled from the web and a judge could not — so a judge version could be tagged by an agent and not by a person |
| `/products/:id/versions` | the imported version ledger under the releases. Without it a product page cannot answer "what shipped between these two", which is what a timeline is for |

**Two were deliberately NOT closed, and the client methods for them were removed again.**
`/scorecards/gate` (release-gate a candidate against a baseline) and `/benchmarks/:id/judge` (a benchmark's
official scorer as a registerable code judge) both needed a surface I would have been guessing at. A control
placed by guess is worse than a named debt: it looks like a decision. They went back on the OWED list, and
the client methods came back out — a client method with no caller is the unwired-capability defect this
repository has a gate against, and adding one to make a counter move is the exact mistake this page is a
record of.

| `/workspace/trace-thresholds` · `/workspace/trace-ingestion` | perception and admission — both applied to EVERY trajectory, neither readable from the web. A workspace could be silently dropping OTLP events past a quota nobody could see. `null` is kept apart from a number, because "no ceiling" and "admit nothing" are opposite settings and an empty box must not become the second |
| `/workspace/images/mirror` · `/workspace/images/push-grant` | the managed store's two member acts. The push credential is shown ONCE and never stored — the web is not a place to keep it, and a page that saved it would be a second copy nobody asked for |
| `/environments` · `versions/:v` · `versions/:v/tags` | the environment REGISTRY, beside the adopted images rather than on a page of its own: an image is bytes, an environment is the world those bytes make, and only the second is an identity axis a batch can seal. Two pages would make a reader memorise which one holds which noun |

| `/checkpoints` (+ get, verify) | a handoff is EVIDENCE about how a task stopped — and it could be written by an agent, verified by an agent, and read by nobody else. Not-verified is drawn apart from verified-and-inconclusive, because the first means nobody asked. Verification needs no confirm: the verifier runs with an empty write list, so asking changes nothing except what is known |
| `/groups` (+ get, score) | the two-phase experiment. Phase 1 runs ungraded and phase 2 judges the runs that already exist without re-executing them — the split is what makes a second question cost only the judge, and only an agent could ask it. The list links each group to `/scorecard/:id` rather than growing a second detail view of one record |
| `/fs/revisions` · `/sandboxes/:id/tasks/:id/trace` | **not gaps — the scanner was wrong.** See below |

| `/knowledge/*` (all 8) | the web could DRAW the graph and author nothing in it. A graph a person can only look at is a report; the notes and the typed edges are what make it a place work accumulates. The note action sends NO author — a note whose author the client could choose is not attribution — and the predicate list is derived from the edges the graph already carries rather than hard-coded, because a second copy of a closed vocabulary drifts. `extract` is an explicit act, never something the page does on open: it is a real billable model call whose result is PROPOSED entries awaiting review |

| `/sandboxes/:id/touch` · `snapshot` · `git/push` | a session could be opened, driven and closed, and the three acts that make one WORTH keeping open were an agent's alone: a person watching a session could only watch it expire, and everything it produced was lost with it. The snapshot's confirm says it mints an immutable world version other cases can reference — it is not a save button — and each act reports what it MADE, because an outward effect nobody can find is one nobody can review |
| `/scorecards/gate` | the release gate, rehearsed on the pair already being compared. FOUR outcomes and only `pass` is a green light: collapsing `not_comparable` or `blocked_missing` into "block" tells a reader the candidate regressed when nobody could tell. An outcome the control plane has no rule for renders as ABSENT rather than as a badge, because a badge for an unknown word is a UI inventing a verdict |
| `/benchmarks/:id/judge` | beside the import, because the halves travel together: cases from the import, criterion from the benchmark's own scorer. NO official scorer is the more important answer — it says the criterion is yours, and that "we ran benchmark X" will not mean the same thing elsewhere unless you say how you scored it |
| `/fs` (DELETE) | governance, not content. It empties EVERY member's files, so the confirm asks for the workspace NAME rather than a yes — a yes/no dialog is the wrong shape for an act whose blast radius is other people's work |

**12 remain OWED — all of them `campaigns`.**

### ⚠️ The scanner's fifth extraction error, found by using it

Two routes sat on the OWED list that the web has always called. The client wraps long query builders across
lines:

    `/fs/revisions?path=${encodeURIComponent(path)}${limit !== undefined ? `&limit=${limit}` : ""}${
      before !== undefined ? `&before=${before}` : ""
    }`

and the scan broke its literal at the first newline — correct for a path, wrong INSIDE a `${…}` group,
where a newline is ordinary formatting. It now breaks on a newline only at depth 0.

That is the fifth spelling of this class (backticked-only matching · a character class without parens · a
trailing `${qs}` read as a segment · a literal-prefix "reachable" check · this). The pattern is worth naming:
**every one was a false report about the SAME kind of value**, and each was found only by driving the tool
against the tree rather than by reading it. A census's extraction is the part that needs the counterexample,
not its conclusions. They are not one more afternoon: `campaigns` (11 routes) is the evolution domain with no
page at all, `knowledge` authoring (8) is a write surface over a graph the web only reads, and the
`sandboxes`/`groups`/`checkpoints`/`environments` clusters are each a product surface somebody has to
design. Calling those
resolved by adding a client method nobody calls would be the unwired-capability defect this repository has a
gate against — so they stay named, and the gate refuses to let a new one join them silently.

What the gate DOES guarantee, and what this page is now the record of: no route can go unreachable without a
decision, no decision can outlive its subject, and the debt has a count that only moves one way.

## Slice 4 — the check that keeps it closed — **Landed**

`pnpm web-reach`. It does not demand a caller; it demands an ANSWER: every browser-facing route is reachable
from the web's one client, or carries a line saying why a person does not need it. An `OWED —` reason keeps
the gate green while a surface is missing and names the debt, so removing that line is the definition of done
for it — and a route that BECOMES reachable must lose its line, because a reason that outlived its subject
reads as permission.

It was listed last because it would have been red, and a gate that lands before its fix teaches people to
bypass gates. It is green now: **364 routes, 72 decided, 55 of them OWED.**

⚠️ **IT FOUND THE HAND CENSUS WRONG, IN BOTH DIRECTIONS.** Its extraction is stricter, and re-running the
count mechanically moved the answer from 36 to 39 with different membership: `/harnesses/:id/pins`,
`/harnesses/:id/lineage`, `/runs/:id/cancel` and `/skills/:id/verify` had been marked REACHABLE by a
literal-prefix check that `/harnesses/${id}` satisfied — a fourth spelling of the same extraction error the
first three passes made. Nine routes the hand sweep never saw (`/scorecards/estimate`, `/trajectories`,
`/sandboxes/:id/*`, the `/ops/driver/*` trio, …) were also found.

Two extraction lessons are in the script, because they are the reason a census like this lies:

- **A nested template truncates the path.** `` `/runs/${id}/trajectory${suffix ? `?${suffix}` : ""}` `` — the
  inner backtick ends a naive match, so a route the web calls on every run page reads as unreachable. The
  scan tracks `${}` depth instead.
- **A trailing `${…}` that builds a query string is not a segment**, and it cannot be matched with a regex
  because the group nests. The tail is found by balancing braces.

It also refuses to run over an empty route corpus, which would otherwise pass over a repository it never
read — the vacuous-green shape this repository's gates keep having to refuse.

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
