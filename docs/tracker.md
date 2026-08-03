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
| **Project** | issues under one target date | did we finish the evaluation in time |
| **Initiative** | the deployment umbrella over projects | is everything resolved — can we ship |

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

AuthZ is its own pair, unlike the rest of the tracker: **`teams:read`** (viewer+) and **`teams:write`**
(**admin**). Creating a team mints an identifier prefix every future issue inherits and decides whose list issues
land in — that is workspace administration, not the collaborative eval *content* `issues:write` covers.

## Issue

Every issue belongs to exactly one team (`teamId`, required) and carries the identity that team minted
(`number`, `identifier`). An issue gathers the capabilities that verify it (`links[]`: harness · dataset · judge · scorecard · run ·
view), so the discussion happens where the evidence is. Links are **pointers** — unvalidated, resolved through
the normal RBAC-gated reads at render time, exactly like a platform event's subject. The one validated
reference is `resolution.scorecardId`, because that one is evidence rather than navigation.

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

### Statuses — Linear's six, plus one

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
| `issue.linked` | `linkType`, `linkId`, `version?` | — |
| `project.created` / `project.status_changed` | `from`, `to`, `openIssues`, `onTime?`, `forced?` | status only |
| `initiative.created` / `initiative.status_changed` | `from`, `to`, `openIssues`, `onTime?`, `forced?` | status only |

"Wake me when an issue regresses" is therefore a payload filter (`cause eq regression`), not another kind —
the vocabulary stays small and the subscription stays precise. Facts, never judgments: `regression` states
that a linked scorecard's pass rate fell below the resolution scorecard's, which is arithmetic over sealed
results.

### Evaluation history

`GET /issues/:id/scorecards` returns the scorecards **pinned to the issue as evidence** ∪ **every batch its
linked datasets/harnesses ran** (newest first, capped at 100). The second half is where a regression against a
closed issue actually surfaces: nobody re-links a scorecard that has not happened yet, but the nightly batch on
the linked dataset runs anyway. The derived half uses the scorecard store's existing `dataset`/`harness`
filters — the SQL narrows, nothing scans the workspace.

## GitHub import + manual sync

Everdict stays the **client**: there is no inbound webhook (`docs/architecture/workspace-scoped-integrations.md`)
and no periodic sweep. A pull happens when someone presses Sync; a push happens as the effect of a local
transition on a copy whose owner opted in.

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

## Project and Initiative

Both are thin containers with one interesting operation: **completion is a gate.**

- `POST /projects/:id/status {status: "completed"}` refuses with a `409` while the project has open issues,
  naming the count.
- `POST /initiatives/:id/status {status: "completed"}` does the same across *every* project under the
  umbrella.
- `force: true` is the deliberate override — a release ships with known gaps — and it is recorded in the fact
  (`forced: true`) so the history says the deadline was overridden, not met.

The rollups are **derived on detail reads, never stored** (the `ScorecardRecord.trialSummary` precedent):
counting issues is cheap arithmetic, whereas a stored rollup is a cache to invalidate on every child write.
`GET /projects/:id` carries `rollup`, `GET /initiatives/:id` carries `readiness` with its blocker list
(regressions first). List endpoints stay lean.

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
`list_issue_scorecards`, `delete_issue` plus the six-tool sets for projects and initiatives. Every `/issues/:id`
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
packages/domain/src/tracker/                   Team/Issue/Project/Initiative aggregates + readiness arithmetic
packages/application-control/src/{issue,project,initiative}/   use-cases; IssueService.applyTransition is
                                               the ONE choke point for facts AND the GitHub push
packages/application-control/src/issue/github-issue-sync.ts    import + manual two-way sync (no webhook, no sweep)
packages/application-control/src/issue/regression-watch.ts     scorecard.completed → auto-reopen as regressed
packages/db/src/tracker/                       InMemory + Pg stores (migrations 0103, 0105 = teams + backfill)
packages/application-control/src/team/team-service.ts          team use-cases; ensureDefault is the invariant's repair point
apps/api/src/api/{team,issue,project,initiative}/   routes + MCP + OpenAPI docs
```
