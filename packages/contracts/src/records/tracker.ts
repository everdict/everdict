import { z } from "zod";

// The EVAL TRACKER — Initiative ⊃ Project ⊃ Issue (docs/tracker.md). Everdict's primitives (harnesses, datasets,
// judges, scorecards) answer "what ran"; the tracker answers "why we evaluate at all". An Issue is the unit of
// intent — the problem under evaluation — and it gathers the capabilities that verify it, so a workspace discusses at
// the issue level: how it was resolved, which scorecard closed it, and why it came back. Projects group issues
// under a target date; an Initiative is a GOAL several projects work toward — Linear's meaning, not a release
// train. Its progress is the live arithmetic over everything underneath, and completing it is a gate only
// because a goal with open work under it has not been reached yet.
// The workspace is the only boundary: it names every issue (`EVD-12`, records/issue-identifier.ts), and projects and
// initiatives sit beside the issues in the same workspace.

// --- Issue status (Linear's six + one) ---
// `regressed` is our addition and the reason the tracker exists: a done issue whose evaluation later degraded is
// NOT the same as an untouched todo — it carries a resolution (the baseline it fell from) and reads as an alarm.
// OPEN = anything that is not done/cancelled, so a regressed issue blocks its initiative exactly like fresh work.
export const ISSUE_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
  "regressed",
] as const;
export const IssueStatusSchema = z.enum(ISSUE_STATUSES);
export type IssueStatus = z.infer<typeof IssueStatusSchema>;

// --- Status CATEGORIES (Linear's five) ---
// Every status belongs to exactly one category, and category is what PROGRAMMATIC decisions read: the release
// gate, the rollups, the regression watch. Linear calls these the workflow-state `type`, and it is the reason a
// workspace can rename or add states without breaking anything — the name is for humans, the category is for code.
//
// `regressed` maps to `started`, which is the whole argument for having categories at all: a resolution that
// stopped holding is WORK IN FLIGHT, not an untouched backlog item and not a finished one. Every open/closed
// judgment in the tracker now derives from this table instead of repeating a pair of literals.
export const ISSUE_STATUS_CATEGORIES = ["backlog", "unstarted", "started", "completed", "canceled"] as const;
export const IssueStatusCategorySchema = z.enum(ISSUE_STATUS_CATEGORIES);
export type IssueStatusCategory = z.infer<typeof IssueStatusCategorySchema>;

export const ISSUE_STATUS_CATEGORY: Record<IssueStatus, IssueStatusCategory> = {
  backlog: "backlog",
  todo: "unstarted",
  in_progress: "started",
  in_review: "started",
  done: "completed",
  cancelled: "canceled",
  regressed: "started",
};

// The CLOSED half of the vocabulary, DERIVED from the category table above rather than listed again — the
// stores' aggregate counts pass this very array into SQL, so "open" has to mean the same thing whether it is
// decided in TypeScript or by Postgres, and two hand-maintained lists would eventually disagree. `regressed` is
// absent because its category is `started`: a resolution that stopped holding is work in flight.
export const CLOSED_ISSUE_STATUSES: readonly IssueStatus[] = ISSUE_STATUSES.filter(
  (status) => ISSUE_STATUS_CATEGORY[status] === "completed" || ISSUE_STATUS_CATEGORY[status] === "canceled",
);

// ── AND ITS COMPLEMENT, BECAUSE FOUR CALLERS WERE WRITING IT OUT (arch-review 110) ────────────────────
//
// The comment above says the closed vector exists so "open" means one thing in TypeScript and in Postgres. The
// POSITIVE spelling — the one a SQL filter actually passes, because a store selects the statuses it WANTS —
// had no home, so four call sites each re-derived it verbatim: the release store, the product service, the
// initiative service and the workspace pulse. `@everdict/domain` exports `isOpenIssueStatus`, but a predicate
// is not what an `= ANY($1)` takes.
//
// They had not diverged. L3 calls that the state a duplicated predicate is in BEFORE it diverges, and the bill
// arrives the day one of them learns something the others do not — whether a given status counts as open work
// is one decision, and with four copies it would have been four.
//
// Derived as the strict complement of the closed half, so the two vectors partition the vocabulary by
// construction and a status added tomorrow lands in exactly one of them.
export const OPEN_ISSUE_STATUSES: readonly IssueStatus[] = ISSUE_STATUSES.filter(
  (status) => !CLOSED_ISSUE_STATUSES.includes(status),
);

// Calendar dates, not instants: "did we finish evaluation by the 14th" is a date question, and storing the
// literal YYYY-MM-DD round-trips exactly with no timezone reinterpretation on the way in or out.
const CalendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date.");

// --- Priority (Linear's five) ---
// A closed STRING vocabulary rather than Linear's 0–4 integers (`none`=0, `urgent`=1 … `low`=4 on the wire
// there). The values mean the same thing; the spelling is ours because a magic integer whose zero sorts LAST
// is exactly the kind of encoded rule this codebase keeps out of records — `issuePriorityRank`
// (@everdict/domain) owns the ordering instead, in one place, where it can be read.
export const ISSUE_PRIORITIES = ["none", "urgent", "high", "medium", "low"] as const;
export const IssuePrioritySchema = z.enum(ISSUE_PRIORITIES);
export type IssuePriority = z.infer<typeof IssuePrioritySchema>;

// What kind of everdict object an issue points at. Links are POINTERS (same semantics as a platform event's
// subject) — unvalidated by design, resolved through the normal RBAC-gated reads at render time. The one
// exception is `resolution.scorecardId`, which the service validates because it is evidence, not a pointer.
// `issue` is the cross-reference GitHub spells with `#123`: one issue naming another. It is stored like every
// other link — on the MENTIONING issue, one-directional — and the mentioned issue reads its backlinks with the
// same reverse query a harness uses (`?linkType=issue&linkId=`). The id is the target's UUID, not its
// identifier: a re-issue re-mints `ENG-12` into `EVD-3`, and a pointer that survives it is worth more
// than one that reads nicely in the raw record (the screen resolves it to the identifier anyway).
// `product`/`release` point into the product timeline (records/product.ts): "this issue blocks the 2026.3
// release" is a link, and the release's gate counts its open linked issues through the same reverse query.
export const ISSUE_LINK_TYPES = [
  "harness",
  "dataset",
  "judge",
  "scorecard",
  "run",
  "view",
  "issue",
  "product",
  "release",
  // ── THE CASES AN ISSUE IS ABOUT (docs/architecture/evolution-routing-spec.md §3) ─────────────────
  //
  // "These five cases fail" used to be prose in the description. A `case` link names one: `id` is the CASE id,
  // `dataset` the dataset it belongs to, `version` the dataset version (pinned, because a campaign derived from
  // the issue freezes exactly that exam). A campaign opened `fromIssue` reads these as its `targets`, and the
  // gate then adopts only when every one of them flipped — the join that makes "the actual issue was resolved"
  // a verified fact rather than a sentence.
  "case",
  // ── THE COMMIT THAT DID IT (maintainer, 2026-09-17) ─────────────────────────────────────────────────
  //
  // Every other kind in this list addresses something INSIDE the workspace, and that was the whole vocabulary:
  // an issue could name the scorecard that proved it and the issue that duplicates it, and could not name the
  // change that actually fixed it. The commit lived in a change campaign's round, one aggregate away, reachable
  // only by someone who already knew a campaign existed — so the ordinary question "what closed this?" had no
  // ordinary answer.
  //
  // A commit is the first link whose target is NOT ours: `id` is the sha, `repository` is "owner/name", and
  // `host` is unset for github.com (the convention `IssueGithub` and `WorkspaceCiLink` already use). That makes
  // it the first link with no page here, so `issueLinkHref` sends it out to the forge rather than to a route.
  "commit",
] as const;
export const IssueLinkTypeSchema = z.enum(ISSUE_LINK_TYPES);
export type IssueLinkType = z.infer<typeof IssueLinkTypeSchema>;

export const IssueLinkSchema = z.object({
  type: IssueLinkTypeSchema,
  id: z.string().min(1),
  // Absent = "this capability, any version" — which is what a long-lived issue usually means (a harness keeps
  // evolving while the issue stays the same). Pinning a version is the exception, not the default.
  version: z.string().optional(),
  // The dataset a `case` link's id lives in. Present exactly on `case` links (`issueLinkDefects`); a case id
  // without its dataset is a name with no address.
  dataset: z.string().min(1).optional(),
  // The repository a `commit` link's sha lives in ("owner/name"). Present exactly on `commit` links, for the
  // same reason `dataset` is present exactly on `case` links: a sha is unique within a repository and says
  // nothing on its own.
  repository: z.string().min(1).max(200).optional(),
  // Unset = github.com; set = the GitHub Enterprise host. Without it a GHE workspace's commit link would
  // render an address on github.com — a link to SOMEBODY ELSE'S repository, which is worse than no link.
  host: z.string().min(1).max(200).optional(),
  // ── THE ORDER WITNESS (DEFAUL-39 §3, commit links only) ──────────────────────────────────────────
  //
  // The commit's own AUTHOR DATE. ⚠️ `addedAt` below is not this and cannot be: it is when somebody made the
  // link, which is trivially after the acceptance and therefore proves nothing about which came first. Git
  // could refuse back-dating, which is why the file-era chain worked — "a plan written after the diff is not
  // a plan, it is a description that agrees with itself" — and this is the coordinate that carries the same
  // question here.
  //
  // Optional on the SCHEMA because every commit link written before this has none; required by
  // `issueLinkDefects` for a commit link on an issue that HAS a chain (a legacy issue keeps linking).
  committedAt: z.string().min(1).optional(),
  note: z.string().max(500).optional(),
  addedBy: z.string(),
  addedAt: z.string(),
});
export type IssueLink = z.infer<typeof IssueLinkSchema>;

// A commit sha as the forges write one: hex, a 7-character abbreviation at the shortest, 64 for sha-256.
// Compared lowercase, because `ABC1234` and `abc1234` are one commit and would otherwise be two links.
const COMMIT_SHA = /^[0-9a-f]{7,64}$/;

// Normalised at the border so the stored coordinate is the one every reader compares. A sha that is not hex is
// not a sha, and the id is returned unchanged for every other link type — their ids are entity ids.
export function normaliseIssueLinkId(type: IssueLinkType, id: string): string {
  return type === "commit" ? id.trim().toLowerCase() : id;
}

// The creation rule for a link's coordinates, one owner for every door (HTTP DTO, MCP input, the domain
// transition): a `case` needs its dataset and a pinned dataset version, a `commit` needs its repository and a
// sha-shaped id, and every other type carries neither.
export function issueLinkDefects(link: {
  type: IssueLinkType;
  id?: string;
  dataset?: string;
  version?: string;
  repository?: string;
  host?: string;
  committedAt?: string;
}): string[] {
  const defects: string[] = [];
  if (link.type === "case") {
    if (link.dataset === undefined)
      defects.push("a case link names its dataset (`dataset`) — a case id alone has no address");
    if (link.version === undefined)
      defects.push(
        "a case link pins the dataset version (`version`) — a campaign derived from the issue freezes exactly that exam",
      );
  } else if (link.dataset !== undefined) {
    defects.push(`\`dataset\` belongs to case links only (this link is a ${link.type})`);
  }

  if (link.type === "commit") {
    if (link.repository === undefined)
      defects.push('a commit link names its repository (`repository`, "owner/name") — a sha alone has no address');
    else if (!/^[^/\s]+\/[^/\s]+$/.test(link.repository))
      defects.push(`\`repository\` is written "owner/name" (got "${link.repository}")`);
    // The id is the sha itself, so a value that cannot be one is a link that can never resolve — and an
    // unresolvable pointer is exactly what this function exists to refuse at birth rather than at render.
    if (link.id !== undefined && !COMMIT_SHA.test(normaliseIssueLinkId("commit", link.id)))
      defects.push("a commit link's id is the sha — hex, 7 to 64 characters");
    if (link.version !== undefined) defects.push("a commit link carries no `version` — the sha IS the version");
    // An author date that is not a date is not a witness. Parsed rather than pattern-matched, because what
    // the guard COMPARES is a time and a string that never becomes one would compare as `false` forever —
    // silently admitting every commit (protocol L2: a check that cannot fail is not a check).
    if (link.committedAt !== undefined && Number.isNaN(Date.parse(link.committedAt)))
      defects.push(`\`committedAt\` is the commit's author date as an ISO timestamp (got "${link.committedAt}")`);
  } else {
    if (link.repository !== undefined)
      defects.push(`\`repository\` belongs to commit links only (this link is a ${link.type})`);
    if (link.host !== undefined) defects.push(`\`host\` belongs to commit links only (this link is a ${link.type})`);
    if (link.committedAt !== undefined)
      defects.push(`\`committedAt\` belongs to commit links only (this link is a ${link.type})`);
  }
  return defects;
}

// ⚠️ A COMMIT'S URL AND THE PARSE OF A PASTED ONE ARE NOT HERE, and that is deliberate. The web may import
// this package TYPE-ONLY (`pnpm web-imports`, the zod-v3/v4 isolation), so a renderer placed here could not be
// called by the only thing that renders — the issue screen — and would have had to be written a second time in
// `apps/web/src/entities/issue/lib/link-target.ts`. What lives here is what the DOORS and the transition
// decide: the coordinates rule, the identity, the normalisation. Where a commit is shown is the screen's.

// WHICH LINKS ARE THE SAME LINK. One owner, because the answer is used twice — the duplicate refusal when a
// link is added and the match when one is removed — and those two drifting is how a remove takes the wrong row.
//
// The identity is the whole coordinate, never just `type` + `id`: two datasets can each hold a case called
// `c1`, and two repositories can each hold a sha with the same 7-character abbreviation. Before this function
// existed, `unlink("case", "c1")` filtered on type and id alone and removed BOTH of those links.
export function sameIssueLink(
  a: { type: IssueLinkType; id: string; dataset?: string; repository?: string },
  b: { type: IssueLinkType; id: string; dataset?: string; repository?: string },
): boolean {
  return (
    a.type === b.type &&
    normaliseIssueLinkId(a.type, a.id) === normaliseIssueLinkId(b.type, b.id) &&
    a.dataset === b.dataset &&
    a.repository === b.repository
  );
}

// --- Issue labels: a workspace-level registry, referenced by id ---
// Labels are RECORDS, not the free strings they used to be (mig 0107 promoted the old string arrays). An issue
// stores `labelIds`, so renaming a label or recolouring it is one write that every issue sees at once — the
// property the string model could never have. The registry is workspace-wide because a workspace IS the tenant
// here, and one shared vocabulary is what makes a filter mean the same thing on every list.
//
// Colour is a CLOSED vocabulary, not a hex string: the web maps each token to a theme token, so a label stays
// legible in light and dark and nobody can author an off-theme (or invisible) chip. Same rule as charts.
export const ISSUE_LABEL_COLORS = [
  "gray",
  "purple",
  "blue",
  "teal",
  "green",
  "yellow",
  "orange",
  "red",
  "pink",
] as const;
export const IssueLabelColorSchema = z.enum(ISSUE_LABEL_COLORS);
export type IssueLabelColor = z.infer<typeof IssueLabelColorSchema>;

export const IssueLabelRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  // Unique per workspace, compared case-insensitively by the store — "Flaky" and "flaky" are one label, which is
  // also what a GitHub import needs when it maps a remote name onto the registry.
  name: z.string().min(1).max(64),
  color: IssueLabelColorSchema,
  description: z.string().max(500).optional(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type IssueLabelRecord = z.infer<typeof IssueLabelRecordSchema>;

// --- Durable history (record-embedded, NOT the platform-event log) ---
// The event log is swept (deleteOlderThan), so it cannot be the answer to "why did this regress six months ago".
// The tracker's history rides on the record itself — the ScorecardRecord.steps precedent — and the matching
// platform facts are emitted in parallel for the LIVE plumbing (feed, agent triggers, Mattermost).
export const TRACKER_HISTORY_EVENTS = [
  "created",
  "updated",
  "status_changed",
  "resolved",
  "reopened",
  "linked",
  "unlinked",
  "github_imported",
  "github_pulled",
  "github_pushed",
  "github_push_failed",
  "completed",
  "cancelled",
  // A release went out (records/product.ts). Its own word rather than `completed` because "released" is what a
  // reader scans a product's history for — and a forced release must read as shipped-with-overrides, not done.
  "released",
  // A project update was posted — the health judgment plus the sentence explaining it. Its own event because a
  // reader scanning the timeline is looking for exactly these, not for the edits between them.
  "update_posted",
] as const;
export const TrackerHistoryEventSchema = z.enum(TRACKER_HISTORY_EVENTS);
export type TrackerHistoryEvent = z.infer<typeof TrackerHistoryEventSchema>;

export const TrackerHistoryEntrySchema = z.object({
  at: z.string(),
  by: z.string(),
  event: TrackerHistoryEventSchema,
  detail: z.record(z.unknown()).optional(),
});
export type TrackerHistoryEntry = z.infer<typeof TrackerHistoryEntrySchema>;

// The domain caps history at this length (oldest dropped) so sync churn cannot grow a row without bound.
export const TRACKER_HISTORY_LIMIT = 200;

// --- What caused a status transition (fact payload + history detail) ---
// Facts, not judgments: `regression` states that a linked scorecard's pass rate fell below the resolution
// scorecard's — arithmetic over sealed results, never an inference about flakiness.
export const ISSUE_STATUS_CAUSES = ["manual", "github_sync", "regression"] as const;
export const IssueStatusCauseSchema = z.enum(ISSUE_STATUS_CAUSES);
export type IssueStatusCause = z.infer<typeof IssueStatusCauseSchema>;

// How an issue was closed — the "how was it evaluated" half of the tracker's promise. `scorecardId` is the
// evidence, and it doubles as the baseline the regression watch compares later scorecards against.
// ── THE WORK CHAIN (DEFAUL-39, docs/specs/work-chain-invariants-spec.md) ────────────────────────────
//
// A SECOND AXIS, deliberately not a status. `ISSUE_STATUSES` is the board and every rollup, the release gate,
// the pulse and the regression watch decide on its CATEGORY; the chain answers a different question — has
// this been designed, decided, and shipped — and putting `accepted` in the enum would grow an arm on each of
// those readers for a value that is not about progress ("a phase added to an object's life is a new arm for
// every reader of that object").
//
// ⚠️ THE POINT IS THE STATE THIS MAKES UNREPRESENTABLE. `accepted` carries a `design` that is a UNION with no
// third arm, because the file era's real invention was refusing "accepted with neither a spec nor a reason
// there is none" — a state indistinguishable from "nobody picked it up", which was reported as a NOTE for as
// long as it existed, during which the design stage ran once in eighteen changes. An optional `specPath`
// would re-create it exactly: `undefined` reads as "the author did not say".
export const IssueChainSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("draft") }),
  z.object({
    state: z.literal("accepted"),
    at: z.string(),
    by: z.string().min(1),
    design: z.discriminatedUnion("kind", [
      // The spec that governs this request, by its path in the workspace filesystem (`docs/specs/**`). The
      // service refuses a path that does not resolve — a pointer nobody can open is the same silence the
      // declination abolishes, one indirection further out.
      z.object({ kind: z.literal("spec"), path: z.string().min(1).max(600) }),
      // `Design: none — <why>`. A declination someone can read is a decision; silence is the drift.
      z.object({ kind: z.literal("declined"), why: z.string().min(1).max(1000) }),
    ]),
  }),
  z.object({
    state: z.literal("rejected"),
    at: z.string(),
    by: z.string().min(1),
    // Required, for the same reason the declination is: "the ideas that were turned down are half of what an
    // intent home is for". `cancelled` with no reason does not satisfy that.
    reason: z.string().min(1).max(2000),
  }),
  z.object({ state: z.literal("shipped"), at: z.string(), by: z.string().min(1) }),
]);
export type IssueChain = z.infer<typeof IssueChainSchema>;
export type IssueChainState = IssueChain["state"];
export type IssueDesign = Extract<IssueChain, { state: "accepted" }>["design"];

export const IssueResolutionSchema = z.object({
  scorecardId: z.string().optional(),
  note: z.string().max(2000).optional(),
  by: z.string(),
  at: z.string(),
});
export type IssueResolution = z.infer<typeof IssueResolutionSchema>;

// --- GitHub copy + manual sync state ---
// Ownership split (docs/tracker.md): GitHub owns title/description/labels/comments and the open↔closed
// state-of-record; everdict owns the status nuance (in_progress/in_review/regressed), projectId, links,
// resolution and assignee. Pull lets the remote win on GitHub-owned fields; push writes state + a comment.
// There is no field-level merge, and no inbound webhook — everdict stays the client (workspace-scoped-integrations.md).
export const IssueGithubCommentSchema = z.object({
  author: z.string(),
  body: z.string(),
  createdAt: z.string(),
  url: z.string(),
});
export type IssueGithubComment = z.infer<typeof IssueGithubCommentSchema>;

// Capped so an issue with a thousand-comment thread cannot bloat the row — the newest slice is the context a
// reader (or an agent) actually needs; the full thread is one click away on GitHub.
export const ISSUE_GITHUB_COMMENT_LIMIT = 50;

export const IssueGithubSyncSchema = z.object({
  // Pull is manual-but-default-on (a member presses Sync); push is opt-in because it writes to someone else's
  // tracker — closing a GitHub issue is not a side effect anyone should get by surprise.
  pull: z.boolean(),
  push: z.boolean(),
});
export type IssueGithubSync = z.infer<typeof IssueGithubSyncSchema>;

export const IssueGithubErrorSchema = z.object({
  at: z.string(),
  op: z.enum(["pull", "push"]),
  message: z.string(),
});
export type IssueGithubError = z.infer<typeof IssueGithubErrorSchema>;

export const IssueGithubSchema = z.object({
  // Unset = github.com; set = the deployment's GitHub Enterprise host (same convention as WorkspaceCiLink).
  host: z.string().optional(),
  repository: z.string().min(1), // "owner/name"
  number: z.number().int().positive(),
  url: z.string(),
  state: z.enum(["open", "closed"]),
  // The remote's own `updated_at` at the last successful pull — a REMOTE clock reading, so clock skew between
  // the control plane and GitHub can never make us skip an update. It also suppresses the echo of our own push.
  syncedAt: z.string().optional(),
  sync: IssueGithubSyncSchema,
  comments: z.array(IssueGithubCommentSchema).default([]),
  // Sync is best-effort by contract: a failure is recorded here and surfaced in the UI, never thrown at the
  // member whose local transition already succeeded.
  lastError: IssueGithubErrorSchema.optional(),
});
export type IssueGithub = z.infer<typeof IssueGithubSchema>;

export const IssueRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  // The workspace sequence and its rendered form (`EVD-12`). Stored rather than derived: the issue key is
  // immutable, so the identifier is stable for the life of the issue and readable without loading the workspace.
  number: z.number().int().positive(),
  identifier: z.string().min(1),
  // Every identifier this issue has answered to before, oldest first. Folding the team axis into the workspace
  // (`scripts/live/migrate-teams-to-workspace.mjs`) re-minted names from the workspace counter, which would
  // otherwise break every link already pasted into a pull request or a chat message. Keeping the old
  // names resolvable — the lookup falls back to this list and the web redirects to the canonical slug — is what
  // lets the address change without any of its existing spellings dying.
  formerIdentifiers: z.array(z.string()).default([]),
  title: z.string().min(1),
  description: z.string().optional(),
  status: IssueStatusSchema,
  // ⚠️ ABSENT IS A THIRD VALUE, NOT `draft` (spec §5). Every issue predating the chain has none, and reading
  // that as "draft" would render an already-shipped request as one nobody has designed — and then accepting
  // it would date its acceptance after its own commits. There is no backfill: an issue enters the chain when
  // somebody accepts or rejects it, and until then the tracker honestly has two populations.
  chain: IssueChainSchema.optional(),
  // How urgent, independent of where it sits in the workflow: a backlog item can be urgent and an in-progress
  // one can be nobody's priority. Defaulted rather than optional because "unprioritised" is a real answer that
  // every list has to draw, and an absent field would make every consumer invent the same fallback.
  priority: IssuePrioritySchema.default("none"),
  // Points. A bare number on purpose: the record stores the value, never a rendering of it.
  estimate: z.number().int().nonnegative().max(1000).optional(),
  // When this issue is due — a calendar date like a project's target date, and for the same reason: "is it late"
  // is a date question, and the literal YYYY-MM-DD round-trips with no timezone reinterpretation.
  dueDate: CalendarDateSchema.optional(),
  // The issue this one breaks out of. Sub-issues are ordinary issues in every other respect — they carry their
  // own status and count in every rollup — so this is a pointer, not a containment. The
  // service refuses a cycle (nothing may be its own ancestor) and refuses deleting an issue that still has
  // children rather than silently orphaning them.
  parentId: z.string().optional(),
  // The project checkpoint this issue belongs to. Only ever one of ITS project's milestones — the service
  // refuses another project's, because a checkpoint an issue cannot appear under is work made invisible.
  milestoneId: z.string().optional(),
  // Which of the workspace's named workflow states the issue sits in (records/workflow-state.ts). The
  // canonical `status` above stays the programmatic answer; this is the workspace's spelling of it, and absent
  // means "the default state for that status" — which is every issue that predates the board, and every one
  // the regression watch moved (nobody dragged it into a column).
  stateId: z.string().optional(),
  projectId: z.string().optional(),
  assignee: z.string().optional(),
  // Ids into the workspace label registry above — NOT names. A reader that needs to draw a chip joins against
  // `GET /issue-labels` (the same join the web already does for members and projects); a dangling id cannot
  // happen because deleting a label strips it from every issue in the same transaction.
  labelIds: z.array(z.string()).default([]),
  links: z.array(IssueLinkSchema).default([]),
  // Set when the issue reached `done`. Kept across a reopen — a regressed issue must remember the scorecard it
  // fell from, which is exactly the baseline the regression watch needs.
  resolution: IssueResolutionSchema.optional(),
  github: IssueGithubSchema.optional(),
  history: z.array(TrackerHistoryEntrySchema).default([]),
  createdBy: z.string(),
  // Agent attribution when a conversation created the issue (the causedBy loop guard keys on it).
  origin: z
    .object({
      agentId: z.string().optional(),
      conversationId: z.string().optional(),
    })
    .optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type IssueRecord = z.infer<typeof IssueRecordSchema>;

// --- The LIST projection ---
// A list screen draws an identifier, a title, a status and a few chips; it never draws a description or an
// audit trail. Serving the full record anyway made `GET /issues` read and Zod-parse every row's `history` and
// `description` — 4 MB and 150 ms for a 2,000-issue workspace, of which the page used a few kilobytes. This is
// the same split `ScorecardStore.list` already makes by omitting per-case results: the LIST is a projection,
// the DETAIL (`GET /issues/:id`) stays the whole record.
//
// What is dropped and why: `description`/`history` (unbounded, detail-only), `formerIdentifiers`/`origin`
// (never rendered in a row), `links` → `linkCount` (rows show the count), and the GitHub copy → the three
// fields a row actually needs, because the full one carries a 50-comment slice.
export const IssueSummaryGithubSchema = z.object({
  host: z.string().optional(),
  repository: z.string().min(1),
  pull: z.boolean(), // whether the bulk sync's working set includes this issue
});
export type IssueSummaryGithub = z.infer<typeof IssueSummaryGithubSchema>;

export const IssueSummarySchema = z.object({
  id: z.string(),
  tenant: z.string(),
  number: z.number().int().positive(),
  identifier: z.string().min(1),
  title: z.string().min(1),
  status: IssueStatusSchema,
  // Drawn in a row: the priority icon, the "late" treatment on a due date, the estimate chip, and the marker
  // that says this row is somebody's sub-issue. All four are scalars, so projecting them costs a row nothing.
  priority: IssuePrioritySchema.default("none"),
  estimate: z.number().int().nonnegative().optional(),
  dueDate: CalendarDateSchema.optional(),
  parentId: z.string().optional(),
  milestoneId: z.string().optional(),
  stateId: z.string().optional(),
  projectId: z.string().optional(),
  assignee: z.string().optional(),
  labelIds: z.array(z.string()).default([]),
  linkCount: z.number().int().nonnegative(),
  // How much conversation is on this issue — the thread badge a list row carries, replies included. It does NOT
  // come from the issue table (comments are their own store), so `IssueService` fills it from one batched
  // count per page. Deliberately OPTIONAL rather than defaulted to 0: absent means "nobody counted", 0 means
  // "counted, and there are none". A default would make an unwired comment store report every issue as silent.
  commentCount: z.number().int().nonnegative().optional(),
  // Kept despite being detail-ish: a regressed row names the scorecard it fell from, and that is the one thing
  // a regression alarm has to show without a second read.
  resolution: IssueResolutionSchema.optional(),
  github: IssueSummaryGithubSchema.optional(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type IssueSummary = z.infer<typeof IssueSummarySchema>;

// One PAGE of the issue list, in the house pagination shape (`{ items, nextCursor? }`, opaque base64url token,
// absent = last page) — the same contract `TrajectoryStore.list` serves.
export const IssuePageSchema = z.object({
  items: z.array(IssueSummarySchema),
  nextCursor: z.string().optional(),
});
export type IssuePage = z.infer<typeof IssuePageSchema>;

// --- How a list is ORDERED, and how it is GROUPED ---
// Both belong to the LIST, not to the record: an issue has no ordering, a screen does. They live in the
// contracts anyway because neither is something a caller can apply on top of a page it already holds — the
// ordering decides what the page CURSOR means (a token minted under one ordering cannot be read under
// another), and the grouping decides an aggregate only the store can compute.
export const ISSUE_ORDERS = ["updated", "created", "priority", "due"] as const;
export const IssueOrderSchema = z.enum(ISSUE_ORDERS);
export type IssueOrder = z.infer<typeof IssueOrderSchema>;

// The columns a list can be grouped by — each a SCALAR on the issue, so every row belongs to exactly one group
// and the count is a plain GROUP BY. Labels are deliberately absent: an issue carries several, so grouping by
// label would put one row in several groups and the group counts would add up to more than the list.
// ⚠️ `chain` IS HERE BECAUSE THE INVARIANT OWES A COUNT (DEFAUL-39 §5). The tracker has two populations —
// requests in the work chain and requests born before it existed — and "the invariant is ON" and "the
// invariant COVERS anything" are different facts. Grouping by it is how the second one gets an answer, and
// the chainless bucket is the existing UNSET group, which is exactly its meaning: nobody has said.
export const ISSUE_GROUP_BYS = ["status", "assignee", "priority", "project", "chain"] as const;
export const IssueGroupBySchema = z.enum(ISSUE_GROUP_BYS);
export type IssueGroupBy = z.infer<typeof IssueGroupBySchema>;

// How many issues sit in each group, under the SAME filter the list is drawn with. A grouped list cannot get
// this from its rows: it holds one page per group, so counting what it received would report the page size.
// `key: null` is the UNSET bucket (no assignee, no project, no cycle) — a group a list has to draw, which is
// why it is a null key rather than a missing entry.
export const IssueGroupCountSchema = z.object({
  key: z.string().nullable(),
  count: z.number().int().nonnegative(),
});
export type IssueGroupCount = z.infer<typeof IssueGroupCountSchema>;

export const IssueGroupCountsSchema = z.object({
  groupBy: IssueGroupBySchema,
  groups: z.array(IssueGroupCountSchema),
  // Every issue the filter selects, groups included — the number a header shows next to the list's own name.
  total: z.number().int().nonnegative(),
});
export type IssueGroupCounts = z.infer<typeof IssueGroupCountsSchema>;

// --- Health (the "update" Linear posts) ---
// A judgment a HUMAN makes, unlike everything else the tracker records — which is exactly why it lives on a
// posted update with a body rather than being inferred from the rollup. "Behind on issue count" is arithmetic;
// "at risk" is somebody saying so, and the sentence they said it in is the useful half.
//
// ONE vocabulary for both levels a human reports on (a project and the goal it serves): the same three words
// mean the same three things, and two enums would have made "at risk" a different value depending on which
// screen you were reading.
export const TRACKER_HEALTH = ["on_track", "at_risk", "off_track"] as const;
export const TrackerHealthSchema = z.enum(TRACKER_HEALTH);
export type TrackerHealth = z.infer<typeof TrackerHealthSchema>;

export const ProjectUpdateRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  projectId: z.string(),
  health: TrackerHealthSchema,
  body: z.string().max(50_000),
  createdBy: z.string(),
  createdAt: z.string(),
});
export type ProjectUpdateRecord = z.infer<typeof ProjectUpdateRecordSchema>;

// --- Milestones: the checkpoints inside a project ---
// Embedded on the project rather than a table of their own: there are a handful per project, they are never
// read without it, and an issue points at one by id. `sortOrder` is what makes them a SEQUENCE — milestones are
// steps toward a date, so the order is the meaning, not a display preference.
export const ProjectMilestoneSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  targetDate: CalendarDateSchema.optional(),
  sortOrder: z.number().int().nonnegative(),
});
export type ProjectMilestone = z.infer<typeof ProjectMilestoneSchema>;

// --- Project: issues under one target date ---
// Linear's six, under our spelling: `in_progress` is its "started" (the issue vocabulary already spells the
// middle of a workflow that way, and one product should not name the same idea twice). `backlog` is work that
// is not scheduled yet and `paused` is work that stopped without being abandoned — the distinction a status
// list that only knows planned/in_progress loses, which is how a stalled project keeps reading as active.
export const PROJECT_STATUSES = ["backlog", "planned", "in_progress", "paused", "completed", "cancelled"] as const;
export const ProjectStatusSchema = z.enum(PROJECT_STATUSES);
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

export const ProjectRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  name: z.string().min(1),
  description: z.string().optional(),
  status: ProjectStatusSchema,
  // Who is answerable for the project, and who is on it. The lead is a subject (the same identity every other
  // actor field carries), and membership is a plain list rather than a roster table: a project's members are a
  // statement about this project, not a second workspace directory.
  lead: z.string().optional(),
  memberIds: z.array(z.string()).default([]),
  // The health of the LATEST update, kept on the project so a list row can show it without reading the update
  // timeline per row. Absent = nobody has posted an update, which is different from "on track".
  health: TrackerHealthSchema.optional(),
  // The checkpoints inside the project, in order.
  milestones: z.array(ProjectMilestoneSchema).default([]),
  // The initiatives this project rolls up into — also a list, because one project routinely serves two goals
  // (a migration that is both "Q3 reliability" and "cost down"), and forcing a single choice silently drops
  // whichever goal lost. Progress counts the project under EVERY initiative that claims it.
  initiativeIds: z.array(z.string()).default([]),
  targetDate: CalendarDateSchema.optional(),
  completedAt: z.string().optional(),
  history: z.array(TrackerHistoryEntrySchema).default([]),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProjectRecord = z.infer<typeof ProjectRecordSchema>;

// --- Initiative: the goal several projects work toward ---
// `planned` is where a goal starts: somebody is still deciding what it means and which projects serve it, and
// calling that "active" made every idea look like work in flight. Moving to `active` is the moment the work
// under it begins — a transition somebody makes, not a side effect of creating the record.
export const INITIATIVE_STATUSES = ["planned", "active", "completed", "cancelled"] as const;
export const InitiativeStatusSchema = z.enum(INITIATIVE_STATUSES);
export type InitiativeStatus = z.infer<typeof InitiativeStatusSchema>;

// A link out of the goal — the design doc, the dashboard, the thread where it was argued. Kept ON the record
// rather than in the description because a reader scanning a goal wants these as targets, not as prose they
// have to find; the same reason an issue's linked capabilities are a list and not a paragraph.
export const InitiativeResourceSchema = z.object({
  label: z.string().min(1).max(200),
  url: z.string().url().max(2000),
});
export type InitiativeResource = z.infer<typeof InitiativeResourceSchema>;

export const INITIATIVE_RESOURCE_LIMIT = 20;

export const InitiativeRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  name: z.string().min(1),
  description: z.string().optional(),
  // One emoji, so a goal is recognizable in a list before its name is read. Emoji rather than an icon set
  // because the vocabulary is then the platform's, not a table we have to keep extending — and rather than a
  // colour, because a colour needs a closed theme-mapped vocabulary (the LabelDot rule) and a goal picked from
  // a nine-swatch palette says less than 🎯 does.
  icon: z.string().max(8).optional(),
  status: InitiativeStatusSchema,
  // An initiative may sit under another one, so a big bet decomposes instead of flattening into a wall of
  // projects. Progress rolls UP: a parent counts its own projects plus every descendant's, which is the only
  // reading that keeps "how far along is this" true for the goal a human actually points at. The service
  // refuses a cycle (nothing may be its own ancestor) — a cycle would make that roll-up non-terminating.
  parentId: z.string().optional(),
  // Who is answerable for the goal. Same shape as a project's lead and for the same reason: a goal nobody is
  // named on is one nobody reports on, and the update timeline below is what they report through.
  lead: z.string().optional(),
  // Who else is on it. A statement about THIS goal, not a second workspace directory — the same reading a
  // project's member list has. Derivable-looking (the leads of its projects) but not the same claim: somebody
  // can be on the goal without owning any one project under it.
  memberIds: z.array(z.string()).default([]),
  // Where the goal is written down, measured, or argued.
  resources: z.array(InitiativeResourceSchema).default([]),
  // The health of the LATEST posted update, denormalized so a list row shows it without reading the timeline
  // per row. Absent = nobody has posted an update, which is NOT the same claim as "on track".
  health: TrackerHealthSchema.optional(),
  targetDate: CalendarDateSchema.optional(),
  completedAt: z.string().optional(),
  history: z.array(TrackerHistoryEntrySchema).default([]),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type InitiativeRecord = z.infer<typeof InitiativeRecordSchema>;

// The initiative's posted updates — the same judgment a project reports, one level up. Its own record rather
// than a project update with a nullable projectId: they are read as two separate timelines (a goal's update
// summarizes across projects), and a nullable owner column is how one table becomes two half-used ones.
export const InitiativeUpdateRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  initiativeId: z.string(),
  health: TrackerHealthSchema,
  body: z.string().max(50_000),
  createdBy: z.string(),
  createdAt: z.string(),
});
export type InitiativeUpdateRecord = z.infer<typeof InitiativeUpdateRecordSchema>;

// --- Derived read models (computed on detail reads, never stored) ---
// Same treatment as ScorecardRecord.trialSummary: counting issues is cheap and always-fresh arithmetic, whereas
// a stored rollup is a cache to invalidate on every child write.
export const ProjectRollupSchema = z.object({
  total: z.number().int().nonnegative(),
  open: z.number().int().nonnegative(), // not done and not cancelled — regressed counts here
  done: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
  byStatus: z.record(IssueStatusSchema, z.number().int().nonnegative()),
  // Done AND closed with a scorecard — "resolved" and "resolved with evidence" are different claims, and a
  // release conversation cares about the second one.
  evaluated: z.number().int().nonnegative(),
  ready: z.boolean(), // open === 0
});
export type ProjectRollup = z.infer<typeof ProjectRollupSchema>;

export const InitiativeBlockerSchema = z.object({
  projectId: z.string().optional(),
  issueId: z.string(),
  // The blocker's human name (`ENG-12`) — carried so a readiness card can both NAME the issue and link to it by
  // the identifier the rest of the product addresses issues with, without re-reading the issue.
  identifier: z.string(),
  title: z.string(),
  status: IssueStatusSchema,
});
export type InitiativeBlocker = z.infer<typeof InitiativeBlockerSchema>;

export const InitiativeProjectSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  // Which initiative actually claims this project: absent = this one directly, set = the descendant it came up
  // through. Progress is one flat number, but work that is still open has to say WHERE it sits.
  viaInitiativeId: z.string().optional(),
  status: ProjectStatusSchema,
  // Carried so the goal's project list can draw the same row the project list draws — the reported health and
  // who is answerable are the two things a reader scanning "where does this goal stand" asks per project.
  health: TrackerHealthSchema.optional(),
  lead: z.string().optional(),
  targetDate: CalendarDateSchema.optional(),
  completedAt: z.string().optional(),
  rollup: ProjectRollupSchema,
});
export type InitiativeProjectSummary = z.infer<typeof InitiativeProjectSummarySchema>;

// How far along the goal is. `ready` counts open issues across every non-cancelled project REGARDLESS of that
// project's own status — a project marked completed whose issue later regressed is still unfinished work under
// the goal. The project status is history; this is live truth, and it is what the completion gate reads.
export const InitiativeReadinessSchema = z.object({
  ready: z.boolean(),
  openIssues: z.number().int().nonnegative(),
  totalIssues: z.number().int().nonnegative(),
  projects: z.array(InitiativeProjectSummarySchema),
  blockers: z.array(InitiativeBlockerSchema), // capped — the card lists what is left to do, not everything
});
export type InitiativeReadiness = z.infer<typeof InitiativeReadinessSchema>;

export const INITIATIVE_BLOCKER_LIMIT = 20;
