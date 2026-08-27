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
| **Initiative** | a goal several projects work toward | how far along are we — is everything it asked for finished |

Two axes cross here, exactly as they do in Linear: the **team axis** owns issues, and the **project/initiative
axis** owns dates and goals. Neither contains the other — a project spans teams, and an initiative spans
projects — which is what lets one goal be pursued across several teams without any of them owning it.

An initiative is a GOAL, not a release train. Nothing about it is shipping-shaped: it holds the outcome a group
is trying to reach ("agents people trust", "cost per case under a cent"), its progress is arithmetic over every
issue underneath, and its health is what the person answerable for it says on top of that arithmetic. Completing
one is a gate for exactly one reason — a goal with open work under it has not been reached yet.

## Team

Teams were originally left out on the argument that "a workspace already IS the team boundary". That holds while
a workspace evaluates one thing; it stops holding the moment two groups evaluate different surfaces under one
billing and integration boundary, because every issue list becomes everyone's issue list.

A team is the smallest thing that fixes it, and deliberately no bigger:

- **It owns issues — and, since the ownership axis landed, every eval asset and result beside them** (harness ·
  dataset · judge · rubric · runtime · model · agent · scorecard · run all carry a `teamId`; migration `0106`,
  and the stores filter on it — see `docs/auth.md` "The team axis"). What stays workspace-level is PROJECTS and
  INITIATIVES, so a goal several teams contribute to still has ONE progress read: scoping a project to a team
  would make "how far along is this goal" unanswerable at exactly the moment it matters. A project names several
  teams (`teamIds`) rather than belonging to one.
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
  is a real statement. The roster carries no role — *what* you may do still comes from the workspace role — but it
  does decide *what you may do it to*: writing an **eval asset or result** owned by a team you are not on is
  refused (`canReachTeam`, 403), while reading is decided by team **privacy** rather than by membership. The
  tracker's own records keep the roster as a filing and visibility statement only: an issue, project or
  initiative is not roster-gated on write, which is why none of their routes passes a `teamId` to `gate`. The
  trust zone stays `workspace = tenant` either way — the team axis lives INSIDE a workspace, it does not add a
  tenancy boundary. `docs/auth.md` §"The team axis" is the SSOT for which resources each half covers.

  > ⚠️ This paragraph used to read "never a second authorization axis", which stopped being true two days after
  > it was written — the commit that made it false is titled *"a team is an authorization axis, not just a
  > label"*. Nothing caught it: `docs-check` verifies that cited paths and symbols are alive, and every name here
  > was. A reader adding a team-owned resource would have concluded no write gate was needed and shipped exactly
  > the gap that change closed (arch-review 108).

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

It is also the ONLY thing that hides a team's work — and not only the tracker's. The eval assets (harness ·
dataset · judge · rubric) and the results (scorecard · run) follow the same rule, and so do projects, which are
workspace records naming the teams that work on them (visible when ANY of those teams is). For a while they did
not: reads were gated on the roster itself, so a member of Web could not reuse the judge Mobile wrote, and an
initiative listed a project's progress while the evaluations proving it answered "not found" on the same screen.
One workspace, one rule — public by default, private by choice. See `docs/auth.md`.

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
The one deliberate carve-out is **`teams:join`** (member+): putting YOURSELF on (or off) a public team's roster
is how a member subscribes to a stream of work, not roster governance — `POST /teams/:id/join` / `…/leave`
(MCP `join_team`/`leave_team`) only ever move the caller, answer 404 for a private team the caller cannot see
(joining must not be the probe that confirms it exists) and 409 for a duplicate join, and reuse the ordinary
`team.member_added`/`member_removed` facts with `addedBy` = the joiner. The web offers it in the teams
directory, Settings › Teams, and the sidebar's "Join teams" entry under "Your teams" (Linear's pattern).

### The key is the address, and what a team owns lives under it

The key does for the team what the identifier does for the issue: `GET /teams/ENG`, `PATCH /teams/eng`,
`/{workspace}/team/ENG/issues` in the web. Resolution happens ONCE, in `TeamService.get` — the method every
mutation already routes through — so a key-shaped ref (`TEAM_KEY_REF_PATTERN` in `@everdict/contracts`) is
uppercased, read off the key index, **then falls back to the id**; a uuid costs one lookup, as before. Every
method that resolves then writes uses the RESOLVED id, never the ref it was handed. The id keeps working
forever, and the web redirects an id-spelled URL to the canonical key rather than leaving two live spellings.

The same ref is what a team-scoped LIST takes (`?team=ENG` on issues · projects · cycles · scorecards ·
harnesses · datasets · judges, via `resolveTeamRef` at the route and `resolveTeam` in the MCP twin). An unknown
ref answers **404 rather than an empty list** — a list filtered to nothing reads as "this team has nothing",
which is a different and wrong answer to "no such team".

**In the web, a team's WORK is a PATH, not a query parameter**: `/{workspace}/team/ENG/{issues, triage, cycles,
projects}`, with the team home at `/{workspace}/team/ENG`. `?team=<uuid>` said "the same list, filtered", and
that is not what those are — each team holds different things, its triage inbox exists only if it turned one on,
and its cycles are numbered in its own sequence. The workspace-wide `/issues` and `/projects` stay (they answer a
real question: every team's), and one component renders both addresses; `/cycles` is a redirect to a team's,
because "Cycle 3" has no meaning without whose third it is — and so is `/cycle/<id>`, which now lands on
`…/team/ENG/cycle/7`. Old `?team=` links redirect to the new path, so nothing pasted before this change breaks.

The team's EVALUATION assets are the exception, and deliberately so (user decision 2026-08-05). Harness · dataset
· judge · scorecard briefly had team paths too; they now have ONE workspace address each and the owning team is a
FILTER on that list (`?team=`, the same spelling the old links used, with a team key resolved to its id). The
registry's `team_id` still decides who may CHANGE one — ownership did not move, only the way you navigate to it.
The control plane's `?team=` narrowing on those lists is unchanged.

## Issue

Every issue belongs to exactly one team (`teamId`, required) and carries the identity that team minted
(`number`, `identifier`). An issue gathers the capabilities that verify it (`links[]`: harness · dataset · judge · scorecard · run ·
view · issue), so the discussion happens where the evidence is. Links are **pointers** — unvalidated, resolved through
the normal RBAC-gated reads at render time, exactly like a platform event's subject. The one validated
reference is `resolution.scorecardId`, because that one is evidence rather than navigation.

**One issue can point at another** (`type: "issue"`) — the cross-reference GitHub spells `#123`. It is stored like
every other link, on the MENTIONING issue and one-directional, and the mentioned issue reads its backlinks with the
same reverse query a harness uses (`?linkType=issue&linkId=`), so both screens show the pair without a second
record to keep in step. Two deliberate details: the id is the target's **UUID**, not its identifier, because a team
move re-mints `ENG-12` into `PLT-3` and a containment query on the old spelling would stop matching; and a mention
is made by PICKING (the web's issue picker, `add_issue_link` over MCP), never by parsing `ENG-12` out of a
description — a link nobody chose is one nobody can explain, and edited text would leave the graph to garbage-collect.
Finding the issue to pick is what `GET /issues?q=` answers: a case-insensitive substring of the identifier (including
the ones it used to answer to) or the title. Not the description — a picker row cannot show a paragraph to say why it
matched.

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

**A move drops what the destination team does not own.** Everything the issue points at across the team axis was
checked against the OLD team when it was set, so the move clears its **cycle** and its **board column**
unconditionally, and its **project** (with the milestone inside it) unless the destination team is on that
project too — a project spans teams, so moving *inside* the project's own set of teams is not a departure from
it. Carrying them across would leave the issue in an iteration it can never appear in and a column that is not
on its board: the invariant every other write path enforces, quietly false for exactly the issues that moved.
What it lost is named in the `moved` history entry and on the fact (`dropped: ["cycle", "state", …]`), so an
emptied field never reads as data going missing on its own.

### The identifier is the address

`ENG-12` is not decoration — it is how an issue is **addressed** everywhere a human can see the reference:
`/{workspace}/issue/ENG-12` in the web, `GET /issues/ENG-12` on the control plane, `get_issue({id: "ENG-12"})`
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
"In QA" beside "In review" — and the completion gate, the rollups, the regression watch and the GitHub sync keep
reading `status`, so none of it can be broken by a rename.

This is the one place we deliberately stop short of Linear: **the canonical vocabulary stays closed**. Letting a
team mint arbitrary statuses would mean either teaching every programmatic reader an open vocabulary, or adding
a category field that duplicates the status enum we already have — and the progress arithmetic is the product's
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
| `issue.moved` | `fromTeamId`, `toTeamId`, `fromIdentifier`, `toIdentifier`, `dropped?` (what the destination team does not own: `cycle`/`state`/`project`/`milestone`) | — |
| `issue.linked` | `linkType`, `linkId`, `version?` | — |
| `project.created` / `project.status_changed` | `from`, `to`, `openIssues`, `teamIds`, `initiativeIds`, `onTime?`, `forced?` | status only |
| `project.update_posted` | `health`, `from?`, `teamIds`, `initiativeIds` | ✅ |
| `initiative.created` / `initiative.status_changed` | `from`, `to`, `openIssues`, `onTime?`, `forced?` | status only |
| `initiative.update_posted` | `health`, `from?` | ✅ |

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

`syncPull=true` narrows to the GitHub bulk sync's working set. It is exposed for a reason worth stating: without
it the only way to answer "which repositories can I refresh" was to read the entire issue list and filter it
client-side, which is exactly what the issues page used to do — a second full-table read per page load.

### The screen decides the ordering, the grouping and the sets it filters by

A list screen is more than a page of rows, and the three things it needs beyond them cannot be applied on top of
a page it already holds.

**Ordering.** `?order=updated|created|priority|due` (default `updated`). `priority` sorts urgent-first with
`none` LAST — the ordering lives in `issuePriorityRank`, never as a magic integer — and `due` sorts the nearest
deadline first with undated issues at the end. The page CURSOR is minted under the ordering and carries it, so
reusing a token with a different `order` is a **400**, not a window that silently skips or repeats rows: a
position in one sequence means nothing in another. A two-field token from before orderings existed still
resolves — it can only ever have meant `updated`.

**Sets, not values.** `status`, `priority`, `project`, `assignee`, `cycle` and `label` are repeatable
(`?status=todo&status=in_progress`): ANY within a facet, AND across facets — which is how a filter bar reads.
"Everything still in flight" is one query, where before it was three that no cursor could merge correctly. An
EMPTY value reaches the unset bucket (`?assignee=` = unassigned), because a query parameter has no null and
"nobody" is a group members really do filter to. A facet named with no values selects **nothing** rather than
widening back to everything.

**Group counts.** `GET /issues/counts?groupBy=status|assignee|priority|project|cycle` (`count_issues` on MCP)
answers how many issues each group holds *under the same filter*, largest-first, unset bucket last with
`key: null`. It is its own endpoint because a grouped screen holds one PAGE PER GROUP: there is no single
response the counts could ride on, and counting the rows it received would only report the page size back to
itself. Every grouping column is a scalar on the issue, so an issue counts exactly once — labels are
deliberately absent from `groupBy`, since an issue carries several and the group counts would add up to more
than the list.

The semantics live in the kernel (`issueGroupKey` / `issueOrderKey` / `compareIssuesForList` /
`isIssueAfterCursor` / `orderIssueGroupCounts` in `@everdict/domain`) and the SQL under each store method is
written to reproduce exactly what they return — the in-memory store and Postgres must agree about which row
comes next, and about where a page boundary falls. `updated` keeps the row-value cursor predicate that lets the
`(tenant, …, updated_at DESC)` indexes seek to the page; the other three sort on an expression and pay for a
sort, deliberately: they are chosen from a display menu, and agreeing with the in-memory store is worth more
there than an index.

**What the list is indexed for** (migration 0116, measured with `EXPLAIN ANALYZE` on a 5,000-issue workspace).
Only the team-scoped newest-first read was covered before, and every other shape the screen offers fell off it:
a label filter had no index at all and seq-scanned; the workspace-wide list had nothing leading with
`(tenant, updated_at DESC)` and sorted the whole workspace to serve fifty rows; a facet inside a team seeked on
the team index and then discarded thousands of rows, because that index carries the ordering but not the
predicate. All three are LINEAR in workspace size, which is why the list feels fine on a demo workspace and not
on a real one. 0116 adds a GIN index on `label_ids` (default `jsonb_ops` — `?|` is unsupported by
`jsonb_path_ops`), `(tenant, updated_at DESC, id DESC)` and its `created_at` twin for the two column orderings
and their cursors, and `(tenant, team_id, status, updated_at DESC)` with the status BETWEEN the team and the
ordering, so an equality on it leaves `updated_at DESC` still sorted. That last one is insurance the planner is
meant to ignore for a broad facet (scanning the sorted twin and filtering really is cheaper) and to reach for on
a selective one — "show me what regressed" is a rare status, and it used to walk the whole team to answer.
Still uncovered on purpose: `countByTeam` reads every row of the workspace by definition, so it stays a seq
scan; making it cheaper is a counter or a rollup, not an index.

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

The capability's screen can also MAKE that link ("link an issue" beside the list): it searches issues with `?q=`
and then writes the ordinary `POST /issues/:id/links` on the issue it picked. There is deliberately no
capability→issue write endpoint — the link is one fact, and a second place to store it is a second answer to
"which issues watch this harness". So both directions are the same record, reached from whichever screen you are
standing on.

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
- **A team switches cycles ON** (`cyclesEnabled`, off by default — the same reasoning triage has). Until it
  does, it has no cycles, no sidebar row and no cycle row on its issues. Its cadence is three fields:
  `cycleDurationWeeks` (how long one runs), `cycleStartDay` (0 = Sunday … 6 = Saturday, Monday by default) and
  `upcomingCycleCount` (how many stay standing in front of the active one, 2 by default).
- **The pipeline is provisioned on the READ, never on a timer** (`CycleService.list` with a `teamId` →
  `cyclePipelinePlan`). Asking for one team's cycles stands up the iteration it is in plus `upcomingCycleCount`
  more, so a member never has to plan a cycle before filing work into it. Three properties make that safe: the
  plan is computed from what already exists (idempotent), it only ever APPENDS after the latest end date (a team
  that paused for a month gets one cycle starting this week, not a month of backfill), and a failed plant simply
  leaves the next read to plan again. Provisioned cycles are credited to `CYCLE_CADENCE_ACTOR`, not to whoever
  opened the screen. This runtime has no scheduler that owns tenant data, and the tracker already recovers its
  other structural invariant — a workspace always has a default team — on exactly this kind of read.
- **Creating one by hand still proposes its window** from the same cadence: the day after the latest cycle ends,
  or the team's start weekday on or before today when there is no live sequence to continue. Passing both dates
  overrides it; passing one is a `400`, because half a window is a mistake rather than a shorthand.
- **Progress counts two things** (`cycleProgress`, derived on the detail read): issues by COUNT and points by
  ESTIMATE. An unestimated issue is real work worth zero points — counting it as one would inflate every
  burn-down a team draws, so `estimated` says how many carry an estimate at all.
- **The burn-down is replayed, not stored** (`cycleBurndown`, on the same detail read): one point per ELAPSED
  day carrying what was committed (`scope`) and what was still open (`remaining`). There is no daily-snapshot
  table on purpose — a stored series is a second truth to reconcile, while a replay of the issues can only ever
  agree with them. TWO histories feed it, which is what makes it honest: `status_changed` says when work was
  finished, and the recorded cycle move says when it was in this iteration at all, so work pulled in mid-cycle
  RAISES the scope line on the day it arrived instead of pretending it was always committed. "We did less than
  planned" and "we were given more" are different answers and the graph now distinguishes them. The remaining
  limit is historical only: issues moved before cycle moves were recorded carry no arrival date and count for
  the whole window — the honest fallback, stated on the screen rather than hidden.
- **Closing is not a gate.** An iteration ending with unfinished work is the normal case, which is what the next
  cycle is for. `POST /cycles/:id/complete {moveUnfinishedTo}` closes it and carries everything still open into
  another OPEN cycle of the SAME team in one operation — after the close, so a failed carry-over leaves the
  cycle open (the recoverable half) rather than issues stranded outside a running iteration. The carry-over goes
  through the ISSUE AGGREGATE, never straight at the store, so each moved issue records the move in its own
  history; a silent row update would make the destination's burn-down count carried work as if it had been there
  since day one. The `cycle.completed` fact carries `carriedOver`, which is the number a retro actually asks
  for, and it is trigger-matchable ("the iteration closed — write the summary").
- **Ending an iteration automatically is OPT-IN** (`cycleAutoClose`, off by default). The default is the
  deliberate half: a cycle whose dates passed but which nobody closed is a cycle somebody FORGOT, and every list
  keeps showing it rather than tidying it away — for a team still finding its pace, the forgotten cycle is the
  signal. A team on a settled rhythm wants the iteration to simply end, so it switches this on and the same
  provisioning read closes what expired and rolls the leftovers into the next standing cycle, through the same
  transitions a member's own close uses (so an auto-closed cycle is indistinguishable from a hand-closed one
  afterwards, down to the `carriedOver` count). Order matters: the pipeline is stocked FIRST, because an expired
  cycle already fails the "standing" test, so the iteration the leftovers move into exists by the time the close
  runs. Closing first would strand that work in a closed cycle until the next read.
- An issue joins a cycle through the ordinary edit (`cycleId`), because pulling work into an iteration is a plan
  change, not a workflow transition. It may only join **its own team's** cycles: an issue on a board it can
  never appear on is work made invisible. The move is the ONE edit whose values go into the history
  (`cycleFrom` / `cycleTo` on the `updated` entry, `null` for "no cycle") — everything else can be answered by
  reading the issue as it stands, but "which iteration was this in on the 9th" cannot, and that is what the
  burn-down replays. An absent key and a `null` are deliberately different: absent means the edit predates this
  being recorded, which is the only case that licenses "it was in the cycle all along".
- **Three surfaces put work into an iteration**, because one was not enough: the issue's property column
  (`IssueCycleControl`, beside status/priority/team/project), the create form, and — the one that makes cycles
  usable — MULTI-SELECT in the issue list with a floating "move to cycle" bar. Filing twenty issues into a
  fortnight through a per-issue picker means opening twenty pages, which is how a cycle feature ends up unused.
  Selection lives only where a team scopes the list (an issue may only join its own team's cycles, so "this
  cycle" is meaningless on a mixed workspace list), and all three offer OPEN cycles only — a closed iteration is
  a record, not somewhere to put new work. The bulk move fans the ordinary per-issue edit out rather than adding
  a batch endpoint: the "is this the issue's own team's cycle" judgement must not exist in two places, and
  partial failure is a normal result the screen reports as such.
- **The web's cycle screens** are Linear-shaped. `/{workspace}/team/ENG/cycles` is not a list: it opens the
  iteration the team is IN (falling back to the next one, then the most recent), because everyone who clicks
  "Cycles" is asking about this fortnight and a list answers that only after another click. The title itself is
  the switcher; `…/cycles/7` addresses one iteration by the number people cite, `…/cycles/all` is the full index
  grouped by state, and the old `/{workspace}/cycles/<id>` redirects to the canonical team address the same way
  an id-spelled issue URL redirects to `ENG-12`. The board reuses `IssueListView` under a cycle scope rather
  than growing a second issue list — grouping, filters and the board layout have to be one component, or the two
  copies drift.

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
  on an issue — through the same lazily-repairing `ensureDefault` seam, so a brand-new workspace's first act can
  be creating a project.
- **At least one team, always.** There is ONE kind of project. An empty `teamIds` used to be legal and mean
  "workspace-wide", which quietly made a second kind: a project in no team's sidebar that — under the rule
  below — no issue could ever join. Emptying the list is a `400`, and removing a team whose issues are still in
  the project is a `409` naming the count (which of those issues leaves is the member's decision, not ours).
- A project routinely serves two umbrellas (a migration that is both "Q3 reliability" and "cost down"), and a
  single `initiativeId` silently dropped whichever lost.

**An issue only joins a project its own team is on** — the same rule a cycle has, one level up: a project the
issue's team is not part of is a list the issue can never be seen in from the team that owns it. Enforced on
`POST /issues` and `PATCH /issues/:id` (a `400` naming the project and the team; an unknown project is a `404`),
so the picker a member is offered and the set the control plane accepts are the same set — which is what makes
"this team's projects" a real answer rather than a hint. The web reads that picker's options with
`GET /projects?team=<the issue's team>` for exactly that reason, and a team move re-decides it (above).

Both lists are validated against the workspace on write (`400` naming the unknown ids) — unlike an issue LINK,
which stays an unvalidated pointer. These edges decide which sidebar a project appears in and which goal counts
it, so a dangling id would hide real work rather than merely render a dead chip.

**Initiatives nest** (`parentId`), and progress rolls UP: a parent counts its own projects plus every
descendant's, so decomposing a big goal can never hide work from it. Each project in the progress summary
carries `viaInitiativeId` when it came up through a descendant, so remaining work points at where it actually
sits. Cycles are refused (`409`) and an initiative with sub-initiatives cannot be deleted.

**A goal starts `planned`**, not active: what it means and which projects serve it is still being decided, and
calling that active made every idea look like work in flight. Moving to `active` is a transition somebody makes
(`POST /initiatives/:id/status`), like completing is. It also carries the rest of what a goal has — an `icon`
(one emoji, so it is recognizable in a list before its name is read; emoji rather than a colour, because a
colour needs a closed theme-mapped vocabulary and a nine-swatch palette says less than 🎯 does), `memberIds`
(who is on it, a statement about THIS goal rather than a second directory) and `resources` (`{label, url}`, the
design doc / dashboard / thread you open to understand it) — mig `0122`.

**Both carry the human half too**: a `lead` (who is answerable) and a `health` — the flag on the LATEST posted
update (`on_track | at_risk | off_track`), denormalized onto the record so a list row draws it without reading
the timeline. Updates are their own append-only timelines (`POST/GET /projects/:id/updates`,
`POST/GET /initiatives/:id/updates`, mig `0111` and `0117`), and the body is REQUIRED on both: a health flag with
no sentence is a colour nobody can explain. One health vocabulary (`TrackerHealth`) serves both levels — the same
three words mean the same three things, and two enums would have made "at risk" depend on which screen you read.

**A posted update REACHES somebody.** Both `*.update_posted` facts carry an `excerpt` of the body (240 chars,
`excerptOf`) precisely so their downstream readers can say something worth reading, since none of them can
re-read the timeline from an event. Two consumers ride those facts: `tracker:update-notify`
(`trackerUpdateConsumer`) writes a `tracker_update_posted` bell row for the people the RECORD already names — a
project's lead/members/creator, a goal's lead/creator plus the leads of the projects under it, never the poster
— and the Mattermost channel consumer posts the health line with the excerpt quoted under it. Recipients are
derived, never subscribed: everdict has no subscription table for tracker records, and inventing one to answer
"who cares" would be a worse answer than the record already gives.

Beyond that they are thin containers with one interesting operation: **completion is a gate.**

- `POST /projects/:id/status {status: "completed"}` refuses with a `409` while the project has open issues,
  naming the count.
- `POST /initiatives/:id/status {status: "completed"}` does the same across *every* project under the goal.
- `force: true` is the deliberate override — the goal is closed with known gaps — and it is recorded in the fact
  (`forced: true`) so the history says the deadline was overridden, not met.

The rollups are **derived on detail reads, never stored** (the `ScorecardRecord.trialSummary` precedent):
counting issues is cheap arithmetic, whereas a stored rollup is a cache to invalidate on every child write.
`GET /projects/:id` carries `rollup`, `GET /initiatives/:id` carries `readiness` — how far along the goal is,
with what is left listed regressions-first, and each project summarized with its status, health and lead.
`GET /initiatives` carries the same three numbers per row (`progress`: open / total / projects) but computes
them from ONE aggregate (`countByGroup` over the issue table, twice — total and open) rolled up the tree by
`initiativeProgress` in the kernel, because a list of 20 goals cannot be 20 fan-outs. The two paths share the
rules, not the code, so `initiativeProgress` is tested AGAINST `initiativeReadiness` on the same data: a row
that disagrees with the page it links to is worse than no row. List endpoints stay lean. `GET /projects?team=` and `?initiative=` are containment tests on
the project's own lists (GIN-indexed), so they answer without touching the issue table.

**The load-bearing invariant:** initiative progress counts open issues across every non-cancelled project
*regardless of that project's own status*. A project marked completed whose issue later regressed is still
unfinished work under the goal. The project status is history; this is live truth. A cancelled project's work is
off the goal entirely, so it is summarized but not counted.

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
`list_issue_scorecards`, `move_issue`, `delete_issue` plus the eight-tool sets for projects and initiatives —
create/list/get/update/set-status/delete on both, each with its update pair (`post_project_update`/
`list_project_updates`, `post_initiative_update`/`list_initiative_updates`). Every `/issues/:id`
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
                                               0113 = private teams,
                                               0117 = initiative lead/health + its own update timeline)
packages/application-control/src/team/team-service.ts          team use-cases; ensureDefault is the invariant's repair point
packages/application-control/src/cycle/cycle-service.ts        iteration use-cases (number, window, close+carry)
apps/api/src/api/{team,cycle,issue,project,initiative}/   routes + MCP + OpenAPI docs
```
