---
kind: wiki
title: "The eval tracker — Initiative ⊃ Project ⊃ Issue"
status: current
updated: 2026-08-28
anchors: [packages/domain/src/tracker/issue.ts]
---
# The eval tracker — Initiative ⊃ Project ⊃ Issue

Everdict's primitives answer *what ran*: a harness against a dataset, judged, summarized into a scorecard.
They do not answer *why we ran it*. Run a real product on top of everdict for a few weeks and the gap shows:
harnesses, datasets, judges and scorecards pile up with no way to ask whether the evaluation for a given
problem finished before the deadline, how a defect was actually verified as fixed, or why it came back. That
context lives in GitHub issues, one system away from the evidence.

The tracker is the missing layer, and it is Linear-shaped.

| | what it is | what it answers |
|---|---|---|
| **Issue** | the unit of intent: one problem under evaluation | what are we evaluating, how was it verified, why did it come back |
| **Project** | issues under one target date | did we finish the evaluation in time |
| **Initiative** | a goal several projects work toward | how far along are we — is everything it asked for finished |

One containment chain, and the workspace holds all of it: an initiative spans projects, a project spans issues,
and nothing else owns any of them.

An initiative is a GOAL, not a release train. Nothing about it is shipping-shaped: it holds the outcome a group
is trying to reach ("agents people trust", "cost per case under a cent"), its progress is arithmetic over every
issue underneath, and its health is what the person answerable for it says on top of that arithmetic. Completing
one is a gate for exactly one reason — a goal with open work under it has not been reached yet.

## The workspace is the boundary

There WAS a team here — a group inside a workspace that owned issues, named them (`ENG-12`), carried a roster,
could be private, ran its own cycles and had its own board. It is gone. Migrations `0211`/`0212` collapsed all
seven of those jobs into the workspace, and `scripts/live/migrate-teams-to-workspace.mjs` moved what teams held:
every asset and result is the workspace's, every identifier was RE-ISSUED under one prefix (the old name is kept
on the issue's `formerIdentifiers`, so history still says what a row used to be called), and the board is one
board.

Two consequences worth stating plainly, because they were real properties that no longer hold:

- **A private team's work is no longer hidden.** Reads were narrowed by team privacy; the workspace is the only
  boundary now, so everything a workspace holds is readable by everyone in it. This was chosen deliberately and
  it is not reversible by re-running anything.
- **`ENG-12` no longer resolves.** The prefix moved to the workspace's own `issue_key`, and the re-issue is what
  makes `GET /issues/EVD-12` a unique lookup again. `former_identifiers` keeps the old name findable in the
  record; the ADDRESS is the new one.

### The workspace mints the identifier

`issue_key` (the prefix) and `issue_counter` (the sequence) live on the workspace row. Allocation is a single
conditional `UPDATE … RETURNING` (`PgIssueNumberAllocator`), so two issues filed at the same instant cannot take
the same number — a read-then-write would let them. A workspace the backfill never reached settles its prefix in
that same statement, from `deriveIssueKey`, which the migration script imports rather than re-deriving: a
workspace whose first issue is `EVD-1` and whose backfill then decides the prefix is `ACME` would have two names
for one sequence.

## Issue

Every issue carries the identity the workspace minted (`number`, `identifier`). An issue gathers the capabilities that verify it (`links[]`: harness · dataset · judge · scorecard · run ·
view · issue · product · release · **case**), so the discussion happens where the evidence is. Links are **pointers** — unvalidated, resolved through
the normal RBAC-gated reads at render time, exactly like a platform event's subject. The one validated
reference is `resolution.scorecardId`, because that one is evidence rather than navigation.

**An issue can name the cases it is about** (`type: "case"`): `id` is the case id, `dataset` the dataset it lives in
and `version` the dataset version — both required on a case link (`issueLinkDefects` in `@everdict/contracts`), because
a campaign opened from the issue (`POST /campaigns` with `frame: { fromIssue: true, … }`) freezes exactly that exam:
the linked cases become the frame's `targets`, the version's every other case is held-out, and the gate adopts only
when every target flipped with zero held-out regressions (`docs/architecture/evolution-routing-spec.md` §3). Case links
from two datasets are two exams, and the derivation refuses them by name rather than choosing.

**One issue can point at another** (`type: "issue"`) — the cross-reference GitHub spells `#123`. It is stored like
every other link, on the MENTIONING issue and one-directional, and the mentioned issue reads its backlinks with the
same reverse query a harness uses (`?linkType=issue&linkId=`), so both screens show the pair without a second
record to keep in step. Two deliberate details: the id is the target's **UUID**, not its identifier, because an
identifier is a name a record can be re-issued under and a containment query on the old spelling would stop
matching; and a mention
is made by PICKING (the web's issue picker, `add_issue_link` over MCP), never by parsing `ENG-12` out of a
description — a link nobody chose is one nobody can explain, and edited text would leave the graph to garbage-collect.
Finding the issue to pick is what `GET /issues?q=` answers: a case-insensitive substring of the identifier (including
the ones it used to answer to) or the title. Not the description — a picker row cannot show a paragraph to say why it
matched.

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
- **An estimate is a bare number.** The SCALE (linear / fibonacci / t-shirt) is a rendering choice, so the same
  `3` reads as "3" or "M" — the record stores the value, never its rendering.

`dueDate` is a calendar date, treated exactly like a project's target date. Overdue is a READ concern: the web
colours it only while the issue is open, because a closed issue's passed deadline is history, not an alarm.

**Sub-issues are a pointer, not a containment.** A child is an ordinary issue — its own status, counted in
every rollup exactly once — that names a parent. The service refuses a loop (nothing may be its own
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

### Workflow states — the workspace's own names for its board

The board is `WorkflowState` rows (`/workflow-states`): name · colour · position · and the **canonical status
the state is a view onto**. Rename "Todo" to "Up next", recolour it, reorder the board, add "In QA" beside "In
review" — and the completion gate, the rollups, the regression watch and the GitHub sync keep reading `status`,
so none of it can be broken by a rename.

This is the one place we deliberately stop short of Linear: **the canonical vocabulary stays closed**. Minting
arbitrary statuses would mean either teaching every programmatic reader an open vocabulary, or adding a category
field that duplicates the status enum we already have — and the progress arithmetic is the product's central
claim, so it does not get to depend on what somebody named a column. `regressed` is not offerable as a column at
all: an issue reaches it by a resolution falling, never by somebody dragging a card.

The board is seeded with the default six on the list path, idempotently, so a workspace that has never opened
Settings still has one. An issue names its column with `stateId`; absent means "the default state for that
status", which is what every issue that predates the board reads as — and what the regression watch leaves
behind, honestly, because nobody put that issue in a column.

Reading the board is `issues:read` (viewer+ — knowing the column names is as benign as knowing the issues);
every write is `settings:write`, because shaping a workspace is administration.

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
| `issue.created` | `status`, `source: manual\|github`, `identifier`, `projectId?`, and for a GitHub copy the addressable origin `repository`/`number`/`url` (+ `host?` on GHE) | ✅ |
| `issue.status_changed` | `from`, `to`, `cause: manual\|github_sync\|regression`, `projectId?`, `scorecardId?` | ✅ |
| `issue.linked` | `linkType`, `linkId`, `version?` | — |
| `project.created` / `project.status_changed` | `from`, `to`, `openIssues`, `initiativeIds`, `onTime?`, `forced?` | status only |
| `project.update_posted` | `health`, `from?`, `initiativeIds` | ✅ |
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
response of which the page rendered a few kilobytes. Summaries now come
from one workspace aggregate (`IssueStore.countByGroup`), the same rule the project list already followed:
**the detail carries the rollup, the list stays lean.**

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

**Sets, not values.** `status`, `priority`, `project`, `assignee` and `label` are repeatable
(`?status=todo&status=in_progress`): ANY within a facet, AND across facets — which is how a filter bar reads.
"Everything still in flight" is one query, where before it was three that no cursor could merge correctly. An
EMPTY value reaches the unset bucket (`?assignee=` = unassigned), because a query parameter has no null and
"nobody" is a group members really do filter to. A facet named with no values selects **nothing** rather than
widening back to everything.

**Group counts.** `GET /issues/counts?groupBy=status|assignee|priority|project` (`count_issues` on MCP)
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
Only the newest-first read was covered before, and every other shape the screen offers fell off it:
a label filter had no index at all and seq-scanned, and the list had nothing leading with
`(tenant, updated_at DESC)` and sorted the whole workspace to serve fifty rows. Both are LINEAR in workspace
size, which is why the list feels fine on a demo workspace and not on a real one. 0116 adds a GIN index on
`label_ids` (default `jsonb_ops` — `?|` is unsupported by `jsonb_path_ops`) plus
`(tenant, updated_at DESC, id DESC)` and its `created_at` twin for the two column orderings and their cursors.
Migration `0211` re-cut the rest for the workspace-wide list the product draws now — `(tenant, updated_at DESC)`
and `(tenant, status, updated_at DESC)`, with the status BETWEEN the tenant and the ordering so an equality on
it leaves `updated_at DESC` still sorted. Every index from 0105/0116 led with `(tenant, team_id, …)`, which the
planner can use for none of these reads. Still uncovered on purpose: a workspace-wide count reads every row by
definition, so it stays a seq scan; making it cheaper is a counter or a rollup, not an index.

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

## What went with the team

**Cycles** (a numbered, dated iteration with a carry-over report) and **triage** (a queue in front of the
workflow, with accept/decline) were the team's, not the workspace's: a cycle is numbered in one group's own
sequence, and a triage inbox is a queue in front of one group's workflow. Neither has a meaning once the
workspace is the only boundary — "Cycle 3" answers nothing without whose third it is — so both were removed
rather than re-homed, with their tables (`everdict_cycles`), columns (`issues.cycle_id`, `issues.in_triage`),
routes, tools and event kinds. `scripts/live/migrate-teams-to-workspace.mjs` does not preserve them; the
preflight record says so by name (`docs/migration/preflight/0212-drop-team-axis.md`).

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

**The umbrella edge is many-to-many, and that is the point.** A project carries `initiativeIds` — never a single
id: a project routinely serves two umbrellas (a migration that is both "Q3 reliability" and "cost down"), and a
single `initiativeId` silently dropped whichever lost.

A project used to carry a second list, `teamIds`, and the rules around it (at least one, an issue may only join
a project its own team is on, removing a team with issues still in it is a 409) went with the team axis. Every
project is the workspace's, and every issue may join any of them.

`initiativeIds` is validated against the workspace on write (`400` naming the unknown ids) — unlike an issue LINK,
which stays an unvalidated pointer. This edge decides which goal counts the project, so a dangling id would
hide real work rather than merely render a dead chip.

**Initiatives nest** (`parentId`), and progress rolls UP: a parent counts its own projects plus every
descendant's, so decomposing a big goal can never hide work from it. Each project in the progress summary
carries `viaInitiativeId` when it came up through a descendant, so remaining work points at where it actually
sits. A parent loop is refused (`409`) and an initiative with sub-initiatives cannot be deleted.

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
that disagrees with the page it links to is worse than no row. List endpoints stay lean. `GET /projects?initiative=` is a containment test on the
project's own list (GIN-indexed), so it answers without touching the issue table.

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

Full BFF↔MCP parity. HTTP under `/issues`, `/projects`, `/initiatives`, `/workflow-states`. The issue MCP twins
are `create_issue`, `list_issues`, `get_issue`, `update_issue`, `set_issue_status`, `add_issue_link`,
`remove_issue_link`, `list_issue_scorecards`, `delete_issue` plus the eight-tool sets for projects and
initiatives —
create/list/get/update/set-status/delete on both, each with its update pair (`post_project_update`/
`list_project_updates`, `post_initiative_update`/`list_initiative_updates`). Every `/issues/:id`
route and every issue tool takes the id OR the identifier (`EVD-12`), so an agent can act on the reference a
member pasted at it. The MCP surface is how an agent triages its own regressions: find the issue watching a
harness, read how it was closed last time, move it.

Issues, projects and initiatives are commentable (`COMMENT_RESOURCE_TYPES`), including the `@everdict` agent
answer branch — an issue is where people argue about how something was evaluated, and threading that
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
packages/contracts/src/records/issue-identifier.ts  the key pattern + the identifier format the workspace mints
packages/contracts/src/records/tracker.ts      the three records + the derived read models
packages/contracts/src/wire/tracker/*          response DTOs (detail = record + rollup/readiness)
packages/domain/src/tracker/                   Issue/Project/Initiative aggregates + readiness arithmetic
                                               + the calendar algebra the target dates use
packages/application-control/src/{issue,project,initiative}/   use-cases; IssueService.applyTransition is
                                               the ONE choke point for facts AND the GitHub push
packages/application-control/src/workflow-state/               the workspace's board (seed, re-map, delete gate)
packages/application-control/src/issue/github-issue-sync.ts    import + manual two-way sync (no webhook, no sweep)
packages/application-control/src/issue/regression-watch.ts     scorecard.completed → auto-reopen as regressed
packages/db/src/tracker/issue-number-store.ts  the workspace's counter — one conditional UPDATE … RETURNING
packages/db/src/tracker/                       InMemory + Pg stores (migrations 0103,
                                               0108 = the many-to-many edges + nesting + former identifiers,
                                               0109 = priority/estimate/due date/sub-issues,
                                               0111 = project lead/health/milestones + the update timeline,
                                               0112 = workflow states + issue.state_id,
                                               0117 = initiative lead/health + its own update timeline,
                                               0211/0212 = the workspace becomes the only owner and minter)
apps/api/src/api/{issue,project,initiative,workflow-state}/    routes + MCP + OpenAPI docs
```
