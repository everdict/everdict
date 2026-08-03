# The eval tracker — Initiative ⊃ Project ⊃ Issue

Everdict's primitives answer *what ran*: a harness against a dataset, judged, summarized into a scorecard.
They do not answer *why we ran it*. Run a real product on top of everdict for a few weeks and the gap shows:
harnesses, datasets, judges and scorecards pile up with no way to ask whether the evaluation for a given
problem finished before the deadline, how a defect was actually verified as fixed, or why it came back. That
context lives in GitHub issues, one system away from the evidence.

The tracker is the missing layer, and it is Linear-shaped.

| | what it is | what it answers |
|---|---|---|
| **Team** | who owns a slice of the evaluation, and the prefix its issues are named with | whose list is this issue on |
| **Issue** | the unit of intent: one problem under evaluation | what are we evaluating, how was it verified, why did it come back |
| **Project** | issues under one target date, worked by one or more teams | did we finish the evaluation in time |
| **Initiative** | the deployment umbrella over projects | is everything resolved — can we ship |

Two axes cross here, exactly as they do in Linear: the **team axis** owns issues, and the **project/initiative
axis** owns dates and releases. Neither contains the other — a project spans teams, and an initiative spans
projects — which is what lets one release be planned across several teams without any of them owning it.

## Team

Teams were originally left out on the argument that "a workspace already IS the team boundary". That holds while
a workspace evaluates one thing; it stops holding the moment two groups evaluate different surfaces under one
billing and integration boundary, because every issue list becomes everyone's issue list.

A team is the smallest thing that fixes it, and deliberately no bigger:

- **It owns issues, and only issues.** Projects and initiatives stay workspace-level, so a release several teams
  contribute to is still ONE readiness gate. Scoping a project to a team would make the release question
  unanswerable at exactly the moment it matters.
- **It names them.** `key` (`ENG`) + a per-team counter → `ENG-12`, stored on the issue. The key is immutable
  after creation because it is baked into every identifier the team has already minted, and those get pasted
  into pull requests and chat. Allocation is a single conditional `UPDATE … RETURNING` on the team's counter, so
  two concurrent filings can never be handed the same number.
- **It may sit under another team.** `parentId` nests teams so a large group keeps one issue list per working
  unit while still having a name for the whole ("Platform" over "Runtime" and "Storage"). The nesting is
  organisational only: a sub-team mints its OWN identifiers and owns its OWN issues, so nothing about an issue's
  address depends on where its team sits in the tree. Re-parenting under one's own descendant is a `409`, and a
  team with children cannot be deleted (that would strand them).
- **It has its own roster**, separate from workspace membership — "my teams" is only a useful filter if belonging
  is a real statement. The roster carries no role: permission still comes from the workspace role, so a team is a
  visibility and ownership statement, never a second authorization axis. The trust zone stays `workspace = tenant`.

**A workspace always has at least one team, and exactly one of them is the default.** The default is where an
issue filed without a team lands, which is what lets `teamId` stay required on an issue while callers stay free
to ignore teams entirely. Both halves are enforced by the database (a partial unique index on `is_default`) and
repaired lazily by `TeamService.ensureDefault`, called on the list paths — workspaces come into existence through
several routes (`POST /workspaces`, the api-key bootstrap, the dev fallback), and an invariant that depends on
remembering to call it at each of them is not an invariant. Deleting is refused for the default team, for the
last remaining team, and for a team that still holds issues (409, naming the count).

Facts: `team.created`, `team.member_added`, `team.member_removed`. A rename emits none — it is content editing,
the same split the issue aggregate makes between `update()` and its status transitions. None are
trigger-matchable: there is no automation whose wake signal is "a team was renamed".

### Private teams — visibility, not permission

`isPrivate` hides a team's work from everyone outside its roster. It is deliberately NOT a second authorization
axis: the trust zone stays `workspace = tenant`, `can()` still reads exactly the roles it always did, and the
filter sits ON TOP of `issues:read`.

- The narrowing rides the **same `teamIds` filter** the "my teams" view already uses (`visibleTeamIds` is the
  one place that decides it), so there is one code path in the store and no second place to forget it. Asking
  for `mine` intersects with it — your teams, minus the ones you may not see.
- A refused read answers **404, never 403** — the same no-existence-leak rule cross-workspace reads follow. A
  403 would confirm the team exists, which is the whole thing the privacy is for.
- **Admins see everything, on purpose.** An admin can add themselves to any roster in one click, so hiding the
  data from them would be theatre — and a workspace administrator who cannot answer "what is this team blocked
  on" is a worse failure than the privacy it pretends to buy.

AuthZ is its own pair, unlike the rest of the tracker: **`teams:read`** (viewer+) and **`teams:write`**
(**admin**). Creating a team mints an identifier prefix every future issue inherits and decides whose list issues
land in — that is workspace administration, not the collaborative eval *content* `issues:write` covers.

### The key is the address, and what a team owns lives under it

The key does for the team what the identifier does for the issue: `GET /teams/ENG`, `PATCH /teams/eng`,
`/{workspace}/teams/ENG/issues` in the web. Resolution happens ONCE, in `TeamService.get` — the method every
mutation already routes through — so a key-shaped ref (`TEAM_KEY_REF_PATTERN` in `@everdict/contracts`) is
uppercased, read off the key index, **then falls back to the id**; a uuid costs one lookup, as before. Every
method that resolves then writes uses the RESOLVED id, never the ref it was handed. The id keeps working
forever, and the web redirects an id-spelled URL to the canonical key rather than leaving two live spellings.

The same ref is what a team-scoped LIST takes (`?team=ENG` on issues · projects · cycles · scorecards ·
harnesses · datasets · judges, via `resolveTeamRef` at the route and `resolveTeam` in the MCP twin). An unknown
ref answers **404 rather than an empty list** — a list filtered to nothing reads as "this team has nothing",
which is a different and wrong answer to "no such team".

**In the web, a team's resources are PATHS, not a query parameter**: `/{workspace}/teams/ENG/{issues, triage,
cycles, projects, scorecards}`, with the team home at `/{workspace}/teams/ENG`. `?team=<uuid>` said "the same
list, filtered", and that is not what it is — each team holds different things, its triage inbox exists only if
it turned one on, and its cycles are numbered in its own sequence. The workspace-wide `/issues`, `/projects` and
`/scorecards` stay (they answer a real question: every team's), and one component renders both addresses;
`/cycles` is a redirect to a team's, because "Cycle 3" has no meaning without whose third it is. Old `?team=`
links redirect to the new path, so nothing pasted before this change breaks.

## Issue

Every issue belongs to exactly one team (`teamId`, required) and carries the identity that team minted
(`number`, `identifier`). An issue gathers the capabilities that verify it (`links[]`: harness · dataset · judge · scorecard · run ·
view), so the discussion happens where the evidence is. Links are **pointers** — unvalidated, resolved through
the normal RBAC-gated reads at render time, exactly like a platform event's subject. The one validated
reference is `resolution.scorecardId`, because that one is evidence rather than navigation.

### Moving between teams

`POST /issues/:id/team` hands an issue to another team, and the identifier is **re-minted** from the
destination's counter (`ENG-12` → `PLT-3`). The prefix's whole job is to say whose list the issue is on, so a
moved issue keeping its old name would make the name a lie. What makes re-minting affordable is that the old
name keeps working: every identifier the issue has answered to is kept on the record (`formerIdentifiers`), the
store's `getByIdentifier` falls back to it (GIN-indexed, current spelling always wins), and the web redirects an
old slug to the canonical one. A link pasted into a pull request last month still lands on the right issue.

It is a transition, not an edit — `teamId` is deliberately absent from `PATCH /issues/:id`, so a rename can
never carry a re-address as a side effect. It emits `issue.moved` (both team ids, both identifiers) and appends
the durable `moved` history entry, and moving to the team the issue is already on is a `409`.

### The identifier is the address

`ENG-12` is not decoration — it is how an issue is **addressed** everywhere a human can see the reference:
`/{workspace}/issues/ENG-12` in the web, `GET /issues/ENG-12` on the control plane, `get_issue({id: "ENG-12"})`
over MCP. A link pasted into a pull request or a chat message therefore reads as the issue people already name in
conversation, instead of an opaque uuid nobody can match to the thing being discussed.

Resolution happens ONCE, in `IssueService.get` — the same method every mutation already routes through — so
reads and writes accept the identifier identically and no transport grows its own lookup. A ref matching
`ISSUE_IDENTIFIER_PATTERN` (`@everdict/contracts`) is uppercased and read off the `(tenant, identifier)` unique
index (migration 0105), **then falls back to the id**; anything that cannot be an identifier goes straight to
the id and costs one lookup. The fallback is what keeps the two namespaces from shadowing each other where an
id happens to read like a name — a uuid never does, but the resolver does not depend on that being true. The id
keeps working forever, so links minted before the identifier existed still resolve; the web's detail page
**redirects them to the canonical slug** rather than leaving two live spellings of one address.

### The planning fields

`priority` · `estimate` · `dueDate` · `parentId` — Linear's four, with two deliberate spellings of our own:

- **Priority is a closed STRING vocabulary** (`urgent` · `high` · `medium` · `low` · `none`), not Linear's 0–4
  integers. The values mean the same thing; the encoding is ours because a magic integer whose zero sorts LAST
  is a rule that lives nowhere it can be read. `issuePriorityRank` (`@everdict/domain`) owns the ordering
  instead. `none` is defaulted rather than optional: "unprioritised" is a real answer every list draws, and an
  absent field would make each consumer invent the same fallback.
- **An estimate is a bare number.** The SCALE (linear / fibonacci / t-shirt) is a team setting, so the same `3`
  renders as "3" or "M" depending on the owning team — the record stores the value, never its rendering.

`dueDate` is a calendar date, treated exactly like a project's target date. Overdue is a READ concern: the web
colours it only while the issue is open, because a closed issue's passed deadline is history, not an alarm.

**Sub-issues are a pointer, not a containment.** A child is an ordinary issue — its own status, its own team,
counted in every rollup exactly once — that names a parent. The service refuses a cycle (nothing may be its own
ancestor, checked against the live tree) and refuses deleting an issue that still has children, naming the
count: where they should go instead is the member's decision. `GET /issues?parent=<id>` lists one parent's
children and `?parent=none` the top-level ones, which is what a board needs so a child never appears twice.
None of the four are lifecycle transitions, so they ride `PATCH /issues/:id` and leave one `updated` history
entry — the same split every other content edit makes.

### Statuses — Linear's six, plus one, plus a category

```
backlog · todo · in_progress · in_review · done · cancelled · regressed
```

Every status belongs to exactly one **category** (`ISSUE_STATUS_CATEGORY`) — Linear's workflow-state `type`:
`backlog` · `unstarted` · `started` · `completed` · `canceled`. The category is what PROGRAMMATIC decisions
read, and `isOpenIssueStatus` is now derived from it ("category is neither completed nor canceled") rather than
from a pair of literals repeated per call site. `CLOSED_ISSUE_STATUSES` — the array the stores pass into SQL —
is derived from the same table, so "open" cannot mean one thing in TypeScript and another in Postgres.

`regressed` sits in `started`, which is the whole argument for having categories: a resolution that stopped
holding is work IN FLIGHT, not an untouched backlog item and not a finished one.

### Workflow states — a team's own names for its board

A team's board is `WorkflowState` rows (`/teams/:id/states`): name · colour · position · and the **canonical
status the state is a view onto**. A team renames "Todo" to "Up next", recolours it, reorders the board, or adds
"In QA" beside "In review" — and the release gate, the rollups, the regression watch and the GitHub sync keep
reading `status`, so none of it can be broken by a rename.

This is the one place we deliberately stop short of Linear: **the canonical vocabulary stays closed**. Letting a
team mint arbitrary statuses would mean either teaching every programmatic reader an open vocabulary, or adding
a category field that duplicates the status enum we already have — and the readiness gate is the product's
central claim, so it does not get to depend on what somebody named a column. `regressed` is not offerable as a
column at all: an issue reaches it by a resolution falling, never by somebody dragging a card.

Every team is seeded with the default six on creation (and idempotently on the list path, the same repair
`ensureDefault` does for the default team). An issue names its column with `stateId`; absent means "the team's
default state for that status", which is what every issue that predates the board reads as — and what the
regression watch leaves behind, honestly, because nobody put that issue in a column.

Re-mapping a column's `status` MOVES every issue in it in the same operation, and a state still holding issues
cannot be deleted (409 naming the count) — the board and the record can never disagree.

### The old status list

```
backlog · todo · in_progress · in_review · done · cancelled · regressed
```

`regressed` is the addition, and it is why the tracker exists. A done issue whose evaluation later degraded is
not an untouched `todo`: it carries the resolution it fell from, and it reads as an alarm in every list. **Open
= not done and not cancelled**, so a regressed issue blocks its initiative exactly like unstarted work.

### Transitions

Everything goes through `POST /issues/:id/status` — say where the issue should end up and the control plane
picks the transition that fits its current state. The domain (`packages/domain/src/tracker/issue.ts`) owns
legality and refuses the rest:

- **`done` only via resolve.** Closing records *how it was evaluated* — `resolution = {scorecardId?, note?, by, at}`.
  Setting the status directly is a 400 pointing at the resolution.
- **`regressed` only by reopening a resolved issue.** It means nothing except as the fall from a resolution, so
  a `cancelled` issue cannot regress and a fresh one cannot start there.
- **A reopen keeps the prior resolution.** That is the point: the regression watch needs the scorecard the
  issue fell from, and a manual reopen keeps the record of how it was closed last time.
- An illegal move is the domain's `409`, verbatim through the route.

### Two histories, on purpose

Every transition writes **both**:

1. **`history[]` on the record** — durable, capped at 200 entries (oldest dropped). The platform-event log is
   swept (`deleteOlderThan`), so it can never answer "why did this regress last quarter". This can.
2. **A platform fact** on the E0 same-tx outbox — the live half that feeds the notification feed, Mattermost,
   and agent triggers.

Kinds are folded per subject rather than per verb:

| kind | payload | triggerable |
|---|---|---|
| `issue.created` | `status`, `source: manual\|github`, `teamId`, `identifier`, `projectId?`, and for a GitHub copy the addressable origin `repository`/`number`/`url` (+ `host?` on GHE) | ✅ |
| `issue.status_changed` | `from`, `to`, `cause: manual\|github_sync\|regression`, `projectId?`, `scorecardId?` | ✅ |
| `issue.moved` | `fromTeamId`, `toTeamId`, `fromIdentifier`, `toIdentifier` | — |
| `issue.linked` | `linkType`, `linkId`, `version?` | — |
| `project.created` / `project.status_changed` | `from`, `to`, `openIssues`, `teamIds`, `initiativeIds`, `onTime?`, `forced?` | status only |
| `project.update_posted` | `health`, `from?`, `teamIds`, `initiativeIds` | ✅ |
| `initiative.created` / `initiative.status_changed` | `from`, `to`, `openIssues`, `onTime?`, `forced?` | status only |

"Wake me when an issue regresses" is therefore a payload filter (`cause eq regression`), not another kind —
the vocabulary stays small and the subscription stays precise. Facts, never judgments: `regression` states
that a linked scorecard's pass rate fell below the resolution scorecard's, which is arithmetic over sealed
results.

### The list is a projection, and it is paged

`GET /issues` (and its `list_issues` twin) serves **one page of summaries**, not whole records:
`{ items, nextCursor? }`, newest activity first, 50 per page by default and 200 at most, `nextCursor` passed
back as `cursor` for the next page and absent on the last one. The cursor is the opaque `(updatedAt, id)` pair
the rest of the product uses — the pair rather than the timestamp alone, because two issues touched in the same
millisecond would otherwise straddle a page boundary and one of them would be dropped or repeated.

A row is an `IssueSummary`: identifier, title, status, priority, labels, assignee, the resolution a regressed
row has to name, a `linkCount` instead of the links, and the GitHub copy reduced to `{repository, host?, pull}`.
`description`, `history`, `formerIdentifiers` and `origin` are **not in it** — no list draws them, and on
Postgres those columns are never selected, so they are neither shipped nor parsed. `GET /issues/:id` remains the
whole record; that is the split `ScorecardStore.list` already makes by omitting per-case results.

One field on the row does **not** come from the issue table: `commentCount`. Comments are their own store, so
`IssueService` attaches the totals with a single batched `CommentStore.countByResource` per page — never a read
per row, which is the shape this list exists to avoid. It is **optional on purpose**: absent means nobody
counted (no comment store wired), `0` means counted and there are none. Defaulting it to `0` would have made
those two different facts look identical. Replies count toward the total: the badge answers "how much
conversation is on this issue", not "how many top-level posts".

`assignee` is a **subject**, not a name — the row joins it against the workspace member directory to draw a
face and a display name, exactly as the detail view does. Rendering the raw subject is how a list ends up
showing a uuid where a person should be.

This is not a micro-optimisation. Serving whole records made a 2,000-issue workspace's list a 4 MB, 150 ms
response of which the page rendered a few kilobytes, and it made `GET /teams` — which derived each row's counts
by *listing that team's issues* — cost the same as `GET /issues` for a 1.6 KB answer. Team summaries now come
from two workspace aggregates (`IssueStore.countByTeam` + `TeamStore.countMembersByTeam`), the same rule the
project list already followed: **the detail carries the rollup, the list stays lean.**

**What the list is indexed for** (migration 0116, measured with `EXPLAIN ANALYZE` on a 5,000-issue workspace).
Only the team-scoped newest-first read was covered before, and every other shape the screen offers fell off it:
a label filter had no index at all and seq-scanned the table; the workspace-wide list had nothing leading with
`(tenant, updated_at DESC)` and sorted the whole workspace to serve fifty rows; a status facet inside a team
seeked on the team index and then discarded thousands of rows, because that index carries the ordering but not
the predicate. All three are LINEAR in workspace size, which is why the list feels fine on a demo workspace and
not on a real one. 0116 adds a GIN index on `label_ids` (the default `jsonb_ops` — `?|` is unsupported by
`jsonb_path_ops`), `(tenant, updated_at DESC, id DESC)` and its `created_at` twin for the two column orderings
and the cursors that ride them, and `(tenant, team_id, status, updated_at DESC)` with the status BETWEEN the
team and the ordering, so an equality on it leaves `updated_at DESC` still sorted within the group. That last
one is insurance the planner is meant to ignore for a broad facet — scanning the sorted twin and filtering
really is cheaper — and to reach for on a selective one: "show me what regressed" names a rare status, and it
used to walk the whole team to answer. Still uncovered on purpose: `countByTeam` reads every row of the
workspace by definition, so it stays a seq scan; making that cheaper is a counter or a rollup, not an index.

`syncPull=true` narrows to the GitHub bulk sync's working set. It is exposed for a reason worth stating: without
it the only way to answer "which repositories can I refresh" was to read the entire issue list and filter it
client-side, which is exactly what the issues page used to do — a second full-table read per page load.

### Evaluation history

`GET /issues/:id/scorecards` returns the scorecards **pinned to the issue as evidence** ∪ **every batch its
linked datasets/harnesses ran** (newest first, capped at 100). The second half is where a regression against a
closed issue actually surfaces: nobody re-links a scorecard that has not happened yet, but the nightly batch on
the linked dataset runs anyway. The derived half uses the scorecard store's existing `dataset`/`harness`
filters — the SQL narrows, nothing scans the workspace.

### A capability born from an issue links itself back

Linking used to be a separate act nobody owed anyone: whoever built the judge had to remember `add_issue_link`
after registering it. That is exactly the bookkeeping that gets skipped, and skipping it is not cosmetic — the
regression watch below only reopens a closed issue when the batch's dataset **and** harness are both linked to
it, so an agent that built and ran the evaluation but forgot the link left the issue unable to notice its own
regression.

So the link is made where the birth is recorded. A registration that declares `origin.from = {type:"issue", id}`
(`docs/registry.md`) also adds the issue→capability link, through `withOriginBacklink` — a composition-root
decorator beside `withRegisteredFact`, so routes, MCP tools and headless callers cannot fork the behaviour. Three
properties are deliberate:

- **The link carries no version.** An issue means "this judge", not "this judge at 1.2.0" (`IssueLink.version`),
  and the regression watch matches at id level for the same reason.
- **The actor is the agent, when one acted.** The resulting `issue.linked` fact is stamped
  `causedBy: agent:<id>:<conversation>`, so an agent never wakes on the link its own registration produced.
- **Best-effort, both directions.** Already-linked (the state we wanted) and any other failure are swallowed: the
  member's registration already succeeded, and failing it afterwards over a backlink is a worse answer than a
  missing chip. The origin stamp survives regardless, so the capability still says where it came from.

The reverse read (`GET /issues?linkType=judge&linkId=…`) is what a capability's detail view asks to draw "the
issues watching this" — and it is how a capability registered *before* the origin stamp existed can still show
its issue, with no backfill.

## Cycles — a team's iteration

A cycle is a numbered, dated window that issues are pulled into, so "what are we doing this fortnight" has an
answer instead of a filter someone remembers to apply. It belongs to exactly one **team**: an iteration is how a
working group paces itself. Projects and initiatives keep answering the other question ("did we finish by the
date"), and the two axes never merge.

- **The state is derived, never stored** (`cycleStateOf`): `upcoming` before the start date, `active` from it,
  `completed` only after an explicit close. A cycle whose end date passed but which nobody closed is NOT
  completed — it is a cycle somebody forgot, and every list keeps showing it. `open=true` therefore means "no
  explicit close", never "the dates say so".
- **The number comes from the team's own counter** (`cycleCounter`, the same conditional-UPDATE allocation an
  issue number uses), so `Cycle 7` means the seventh iteration THAT team ran.
- **Creating one proposes its window** from the team's cadence (`cycleDurationWeeks`, default 2): the day after
  the latest cycle ends, for that many weeks, end-inclusive. Passing both dates overrides it; passing one is a
  `400`, because half a window is a mistake rather than a shorthand.
- **Progress counts two things** (`cycleProgress`, derived on the detail read): issues by COUNT and points by
  ESTIMATE. An unestimated issue is real work worth zero points — counting it as one would inflate every
  burn-down a team draws, so `estimated` says how many carry an estimate at all.
- **Closing is not a gate.** An iteration ending with unfinished work is the normal case, which is what the next
  cycle is for. `POST /cycles/:id/complete {moveUnfinishedTo}` closes it and carries everything still open into
  another OPEN cycle of the SAME team in one operation — after the close, so a failed carry-over leaves the
  cycle open (the recoverable half) rather than issues stranded outside a running iteration. The
  `cycle.completed` fact carries `carriedOver`, which is the number a retro actually asks for, and it is
  trigger-matchable ("the iteration closed — write the summary").
- An issue joins a cycle through the ordinary edit (`cycleId`), because pulling work into an iteration is a plan
  change, not a workflow transition. It may only join **its own team's** cycles: an issue on a board it can
  never appear on is work made invisible.

## Triage — the queue in front of the workflow

`TeamRecord.triageEnabled` (off by default) turns on an inbox for work that arrives from outside — an import, an
agent, a request. An issue waiting there carries `inTriage`, a **flag rather than a status**: the status
vocabulary IS the workflow, and something waiting to enter the workflow has not started it. Two transitions
leave the queue, both through the usual choke point:

- `POST /issues/:id/triage/accept {status}` — into the workflow, landing where the member said (`todo` by
  default). Closing straight from triage is refused: an issue is closed with its evidence, not waved through.
- `POST /issues/:id/triage/decline {note}` — cancelled with a reason, and the flag clears. The issue stays on
  the record, because "we said no to this" is an answer somebody looks for later.

`GET /issues?triage=true` is the inbox; `?cycle=<id>` is one iteration's board.

## GitHub import + manual sync

Everdict stays the **client**: there is no inbound webhook (`docs/architecture/workspace-scoped-integrations.md`)
and no periodic sweep. A pull happens when someone presses Sync; a push happens as the effect of a local
transition on a copy whose owner opted in.

**Labels are records, not strings.** An issue carries `labelIds` into a workspace-level registry
(`everdict_issue_labels`, mig 0107): `{name, color, description}` with the name unique per workspace
(case-insensitive) and the colour drawn from a CLOSED vocabulary (`ISSUE_LABEL_COLORS`) so a chip stays
legible in both themes. Renaming or recolouring is one write every issue sees at once, and deleting a label
strips its id off every issue in the SAME transaction — `labelIds` can never dangle. `GET/POST /issue-labels`
+ `PATCH/DELETE /issue-labels/:id` + `GET /issue-labels/:id/usage` (BFF↔MCP parity: `list_issue_labels` /
`create_issue_label` / `update_issue_label` / `delete_issue_label` / `issue_label_usage`), all on the
tracker's existing action pair
(`issues:read` / `issues:write`); facts `issue_label.created` / `.updated` / `.deleted`. The web surface is
**Settings › Labels** (define/rename/recolour/delete, with the delete confirmation showing how many issues the
label comes off) plus the picker on an issue, which can define a label inline the way Linear does.

**Ownership split.** GitHub owns `title` / `description` / `labels` / comments and the open↔closed
state-of-record. Everdict owns the status nuance (`in_progress` / `in_review` / `regressed`), `projectId`,
`links`, `resolution` and `assignee`. Pull lets the remote win on GitHub-owned fields; push writes state plus an
explanatory comment. There is no field-level merge — a merge nobody asked for is worse than a rule everyone
can predict.

**Import** (`GET /issues/import/candidates` → `POST /issues/import`) is idempotent by the remote identity: a
number already imported is skipped, never duplicated, so re-running after a partial failure is safe. An open
issue lands as `todo`; a closed one lands as `done` with a note and **deliberately without a scorecard** —
claiming evidence we do not have would poison every regression comparison that follows.

**Provenance is recorded twice, on purpose.** `record.github` is the LIVE link — sync direction, remote state,
the thread — and a member can detach it (`DELETE /issues/:id/github`). Where the issue *came from* is not that
block: it is the durable first history entry (`github_imported`) plus the `issue.created` fact, and both carry
the **addressable** origin — `repository`, `number`, `url`, and `host` when the copy came from a GitHub
Enterprise server. `owner/name#42` alone is not an address on GHE, so a consumer that reconstructs a
github.com URL from it sends people to the wrong server; carrying the url is what lets the web link the
provenance (imported entry, detach entry, the "Imported from" property row) without reading the live block.
Detaching therefore removes the sync, never the answer to "where did this issue come from".

**Pull** (`POST /issues/:id/sync`, or `POST /issues/sync` for a whole repo) is one incremental `since=` list
call watermarked by the oldest copy's last-seen remote timestamp, then per-issue apply. Two properties matter:

- **Echo suppression.** `syncedAt` stores GitHub's own `updated_at`, and a remote whose timestamp has not moved
  past it is skipped. Our push bumps that timestamp, so the next pull reads it as already-seen instead of as
  news — that is what stops push and pull from chasing each other.
- **State reconciliation goes through the normal transitions.** A remote close calls the same `resolve()` a
  member's close does (with `cause: "github_sync"`), so the fact, the history entry and any agent subscribed to
  it see one shape regardless of who moved the issue.

A single issue's failure is recorded on that issue (`github.lastError`) and the batch continues.

**Push** rides `IssueService.applyTransition` — the same choke point that stamps facts — and is fire-and-forget
by contract. The local transition is already committed when it runs, so a GitHub outage annotates
`github.lastError` and the history, and never rolls anything back or surfaces to the member who moved the issue.

**An imported body's images need a credential the reader does not have.** The description and comments we store
are the remote's own markdown, so a pasted screenshot is a GitHub URL — and on GitHub Enterprise (as on any
private repository) that URL is behind the same authentication the repository is. A browser rendering the issue
here sends no GitHub session with a cross-site image request, so it gets a login page and draws a broken image,
forever. `GET /issues/:id/attachment?url=…` (`issues:read`, MCP twin `get_github_issue_attachment`) fetches the
bytes with the same installation token that fetched the body and streams them back under `cache-control:
private`. Two invariants hold it in place: the URL is **pinned to that issue's own GitHub host** before any
token goes near it (an arbitrary URL would otherwise become a credentialed fetch for anyone who can read one
issue), and a non-image content-type is an **error rather than a rendered response** — an Enterprise server
answers an unauthenticated attachment request with a 200 HTML login page, so without that check a broken image
would silently replace a broken image and nothing would say the token was refused. The web points `<img src>`
at its own `/api/issues/[id]/attachment` BFF route, rewriting ONLY the origins that issue's attachments come
from (`issueAttachmentProxy` — the GHE host, or github.com plus its user-content hosts); an image the body
links from anywhere else still loads straight from its source. A github.com copy routes its own images through
the proxy too, even though a public one would have loaded directly: whether the repository is private is not
something the browser can know, and a slower image beats a broken one.

## Project and Initiative

**Both edges are many-to-many, and that is the point.** A project carries `teamIds` (who is working it) and
`initiativeIds` (which umbrellas it rolls up into) — never a single id of either:

- A project that could name only ONE team would be that team's backlog with a date on it, not a release unit.
  The teams are stored on the project rather than derived from its issues, because the derived answer was "no
  teams" for exactly as long as the project was still being planned — the window where the question is asked.
  Creating one without naming a team lands it on the workspace's default team, the same courtesy `teamId` gets
  on an issue.
- A project routinely serves two umbrellas (a migration that is both "Q3 reliability" and "cost down"), and a
  single `initiativeId` silently dropped whichever lost.

Both lists are validated against the workspace on write (`400` naming the unknown ids) — unlike an issue LINK,
which stays an unvalidated pointer. These edges decide which sidebar a project appears in and which release gate
counts it, so a dangling id would hide real work rather than merely render a dead chip.

**Initiatives nest** (`parentId`), and readiness rolls UP: a parent's verdict counts its own projects plus every
descendant's, so decomposing a big bet can never hide work from the release gate. Each project in the readiness
summary carries `viaInitiativeId` when it came up through a descendant, so a blocked release points at where
the block actually sits. Cycles are refused (`409`) and an initiative with sub-initiatives cannot be deleted.

Beyond that they are thin containers with one interesting operation: **completion is a gate.**

- `POST /projects/:id/status {status: "completed"}` refuses with a `409` while the project has open issues,
  naming the count.
- `POST /initiatives/:id/status {status: "completed"}` does the same across *every* project under the
  umbrella.
- `force: true` is the deliberate override — a release ships with known gaps — and it is recorded in the fact
  (`forced: true`) so the history says the deadline was overridden, not met.

The rollups are **derived on detail reads, never stored** (the `ScorecardRecord.trialSummary` precedent):
counting issues is cheap arithmetic, whereas a stored rollup is a cache to invalidate on every child write.
`GET /projects/:id` carries `rollup`, `GET /initiatives/:id` carries `readiness` with its blocker list
(regressions first). List endpoints stay lean. `GET /projects?team=` and `?initiative=` are containment tests on
the project's own lists (GIN-indexed), so they answer without touching the issue table.

**The load-bearing invariant:** initiative readiness counts open issues across every non-cancelled project
*regardless of that project's own status*. A project marked completed whose issue later regressed still blocks
the release. The project status is history; readiness is live truth. A cancelled project's work is off the
release entirely, so it is summarized but not counted.

`onTime` on a completion fact is `completedAt <= targetDate` — lexicographic comparison over `YYYY-MM-DD`,
which is why target dates are stored as text and round-trip with no timezone reinterpretation.

## AuthZ

One action pair for all three resources: **`issues:read`** (viewer+) and **`issues:write`** (member+). They are
one workflow — an issue only means something inside its project, and a project only inside its initiative — so
splitting them into three pairs would be knob proliferation with no decision behind it. Delete is
`issues:write` plus creator-or-admin in the service; a project or initiative that still holds children refuses
deletion with a `409` rather than orphaning them.

Cross-workspace reads are `404`, never `403` (no existence leak).

## Surface

Full BFF↔MCP parity. HTTP under `/teams`, `/issues`, `/projects`, `/initiatives`. Teams expose
`list_teams`/`get_team`/`create_team`/`update_team`/`set_default_team`/`delete_team` plus
`list_team_members`/`add_team_member`/`remove_team_member`; the issue MCP twins are `create_issue`,
`list_issues`, `get_issue`, `update_issue`, `set_issue_status`, `add_issue_link`, `remove_issue_link`,
`list_issue_scorecards`, `move_issue`, `delete_issue` plus the six-tool sets for projects and initiatives. Every `/issues/:id`
route and every issue tool takes the id OR the identifier (`ENG-12`), so an agent can act on the reference a
member pasted at it. The MCP surface is how an agent triages its own regressions: find the issue watching a
harness, read how it was closed last time, move it.

Issues, projects and initiatives are commentable (`COMMENT_RESOURCE_TYPES`), including the `@everdict` agent
answer branch — an issue is where a team argues about how something was evaluated, and threading that
discussion anywhere else splits the record.

## The regression watch

The loop closes here. A durable-cursor consumer (`tracker:regression-watch`) listens to `scorecard.completed`
and asks, for every issue that is `done` and links **both** the batch's dataset and its harness: did the pass
rate fall below the scorecard that closed it? If so the issue reopens itself as `regressed`, through the normal
transition — so it emits the ordinary `issue.status_changed` fact (with `cause: "regression"`), appends to the
durable history, and, on a push-enabled GitHub copy, reopens the remote issue with the explanation.

Nobody is watching a closed issue. That is precisely why the closed issue has to come find them: the creator
and assignee get a bell notification (`issue_regressed`) naming the drop.

Four guards keep it honest:

- **Both links must match**, at id level. A cross-*version* drop is exactly the signal — the harness moved, the
  issue's guarantee did not.
- **The batch must postdate the resolution.** A late-arriving old run is not news.
- **The resolution scorecard is never its own regression.**
- **Idempotence is structural, not bookkept.** The candidate filter only matches `done` issues, so a
  redelivery (or a deliberate cursor rewind) finds the issue already `regressed` and does nothing. Feed rows
  carry a natural key for the same reason.

The transition is stamped `everdict:regression-watch` — deliberately *not* the `agent:<id>:<conv>` shape, which
is the agent loop guard's key and must stay honest about who actually acted.

## Where the code lives

```
packages/contracts/src/records/team.ts         the Team + TeamMember records, the key pattern, the identifier format
packages/contracts/src/records/tracker.ts      the three records + the derived read models
packages/contracts/src/wire/tracker/*          response DTOs (detail = record + rollup/readiness)
packages/domain/src/tracker/                   Team/Issue/Cycle/Project/Initiative aggregates + readiness
                                               arithmetic + cycle progress/date algebra
packages/application-control/src/{issue,project,initiative}/   use-cases; IssueService.applyTransition is
                                               the ONE choke point for facts AND the GitHub push
packages/application-control/src/issue/github-issue-sync.ts    import + manual two-way sync (no webhook, no sweep)
packages/application-control/src/issue/regression-watch.ts     scorecard.completed → auto-reopen as regressed
packages/db/src/tracker/                       InMemory + Pg stores (migrations 0103, 0105 = teams + backfill,
                                               0108 = the many-to-many edges + nesting + former identifiers,
                                               0109 = priority/estimate/due date/sub-issues, 0110 = cycles+triage,
                                               0111 = project lead/health/milestones + the update timeline,
                                               0112 = per-team workflow states + issue.state_id,
                                               0113 = private teams)
packages/application-control/src/team/team-service.ts          team use-cases; ensureDefault is the invariant's repair point
packages/application-control/src/cycle/cycle-service.ts        iteration use-cases (number, window, close+carry)
apps/api/src/api/{team,cycle,issue,project,initiative}/   routes + MCP + OpenAPI docs
```
