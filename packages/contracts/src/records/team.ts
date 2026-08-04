import { z } from "zod";
import { TrackerHistoryEntrySchema } from "./tracker.js";

// TEAMS — the tracker's grouping layer inside a workspace (docs/tracker.md). The tracker originally omitted
// Linear's Teams on the argument that "a workspace already IS the team boundary". That holds while a workspace
// evaluates one thing; it stops holding as soon as two groups evaluate different surfaces under one billing and
// integration boundary, because every issue list becomes everyone's issue list. A team is the smallest thing
// that fixes it: it owns issues, it names them (`ENG-12`), and it has its own membership.
//
// Deliberately narrow: a team owns ISSUES ONLY. Projects and initiatives stay workspace-level so a release that
// several teams contribute to is still one initiative — which is the shape a readiness gate needs. Team is a
// grouping of intent, not a second tenancy boundary: the trust zone remains `workspace = tenant`.

// The identifier prefix (`ENG` in `ENG-12`). Uppercase so the rendered identifier is stable regardless of how it
// was typed, and short because its whole job is to be readable in a sentence.
export const TEAM_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,5}$/;
export const TeamKeySchema = z
  .string()
  .regex(TEAM_KEY_PATTERN, "A team key is 2–6 characters, uppercase letters or digits, starting with a letter.");

export const TeamRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  // Immutable after creation: it is baked into every issue identifier this team has ever minted, and rewriting
  // those would break links people have already pasted into pull requests and chat.
  key: TeamKeySchema,
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  // A team may sit under another one. Sub-teams are how a large group keeps ONE issue list per working unit
  // while still having a name for the whole — "Platform" holding "Runtime" and "Storage". The nesting is
  // organisational only: a sub-team mints its OWN identifiers and owns its OWN issues, so nothing about an
  // issue's address depends on where its team sits in the tree. The service refuses a cycle, and a team with
  // children cannot be deleted (that would orphan them).
  parentId: z.string().optional(),
  // Exactly one per workspace, enforced by a partial unique index and by the domain's transfer transition. It is
  // where an issue lands when the caller names no team, which is what keeps `teamId` required on an issue
  // without making every caller think about teams.
  isDefault: z.boolean(),
  // Whether this team paces itself in iterations at all. OFF by default, the same reasoning triage has: a team
  // that never asked for a fortnightly rhythm should not find one in its sidebar. Turning it on is what makes
  // the cycle pipeline exist — every field below is meaningless until it is true.
  cyclesEnabled: z.boolean().default(false),
  // How long this team's iterations run, in weeks. Not a schedule — nothing creates cycles on a timer — but
  // the span every proposed and provisioned window is cut to.
  cycleDurationWeeks: z.number().int().min(1).max(12).default(2),
  // The weekday a cycle starts on, 0 = Sunday … 6 = Saturday (Monday by default). A team's first cycle would
  // otherwise start on whichever day somebody happened to plan it, and every cycle after it would inherit that
  // accident — two teams on the same fortnight would be offset by a Wednesday forever.
  cycleStartDay: z.number().int().min(0).max(6).default(1),
  // How many FUTURE iterations are kept standing in front of the active one. Not a hint: the list read
  // provisions up to this many, which is what lets a member drop next fortnight's work into a cycle that
  // already exists instead of planning it first. 0 turns provisioning off without turning cycles off.
  upcomingCycleCount: z.number().int().min(0).max(6).default(2),
  // Close an iteration when its end date passes, carrying whatever is still open into the next standing one.
  //
  // OFF by default, and that default is the deliberate half: everdict's rule is that a cycle whose dates have
  // passed but which nobody closed is a cycle somebody FORGOT, and every list keeps showing it rather than
  // tidying it away. That is the right default for a team still learning its own pace. A team that has settled
  // into a rhythm wants the opposite — Linear's behaviour, where the iteration simply ends — so this is a
  // choice the team makes rather than one the product makes for it.
  cycleAutoClose: z.boolean().default(false),
  // A private team's work is visible only to its roster (and to workspace admins — see below). This is a
  // VISIBILITY filter, never a second authorization axis: the trust zone stays `workspace = tenant`, roles stay
  // the only thing `can()` reads, and every private-team read that is refused answers 404 rather than 403, the
  // same no-existence-leak rule cross-workspace reads follow.
  //
  // Admins see private teams on purpose. An admin can add themselves to any roster in one click, so hiding the
  // data from them would be theatre — and a workspace's administrator being unable to answer "what is this
  // team blocked on" is a worse failure than the privacy it pretends to buy.
  isPrivate: z.boolean().default(false),
  // Whether incoming work lands in this team's triage inbox first. Off by default: a team that has not asked
  // for a queue in front of its workflow should not suddenly have one.
  triageEnabled: z.boolean().default(false),
  // Per-team monotonic sequence behind `<key>-<number>`. Stored on the team (not derived with max()+1) so
  // allocation is a single conditional UPDATE … RETURNING — two concurrent issues cannot be handed one number.
  issueCounter: z.number().int().nonnegative(),
  // The same treatment for cycle numbers ("Cycle 7" is the seventh iteration THIS team ran). Planning a cycle
  // is rare enough that max()+1 would rarely collide — but "rarely" is the wrong word for a number people cite
  // in a retro, and the counter costs one column.
  cycleCounter: z.number().int().nonnegative().default(0),
  history: z.array(TrackerHistoryEntrySchema).default([]),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TeamRecord = z.infer<typeof TeamRecordSchema>;

// Team membership is its OWN roster, separate from workspace membership: a workspace member is not automatically
// in every team, which is the point — an issue list scoped to "my teams" is only useful if belonging is a real
// statement. It carries no role of its own; permission still comes from the workspace role (`issues:*`), so this
// is a visibility and ownership statement, never a second authorization axis.
export const TeamMemberRecordSchema = z.object({
  tenant: z.string(),
  teamId: z.string(),
  subject: z.string(),
  addedBy: z.string(),
  addedAt: z.string(),
});
export type TeamMemberRecord = z.infer<typeof TeamMemberRecordSchema>;

// A team plus the counts a list row wants to show, derived on read like ProjectRollup — never stored, so it can
// never be a cache to invalidate on every issue write.
export const TeamSummarySchema = z.object({
  memberCount: z.number().int().nonnegative(),
  openIssues: z.number().int().nonnegative(),
  totalIssues: z.number().int().nonnegative(),
});
export type TeamSummary = z.infer<typeof TeamSummarySchema>;

// `<key>-<number>` — the human name of an issue. Computed at creation and stored on the issue, because the team
// key is immutable and a stored identifier survives the team row being read separately (or not at all).
export function formatIssueIdentifier(key: string, issueNumber: number): string {
  return `${key}-${issueNumber}`;
}

// The identifier is also how an issue is ADDRESSED — `GET /issues/ENG-12`, `/{workspace}/issues/ENG-12` — so a
// pasted link reads as the issue people name in conversation instead of an opaque uuid. Case-insensitive on the
// way in (a lowercased URL still resolves) and unambiguous against an id: a uuid is lowercase hex in five
// dash-separated groups, so it can never match this shape.
export const ISSUE_IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9]{1,5}-\d+$/;

// The stored form of a reference a caller typed: `eng-12` → `ENG-12`. Returns undefined when the ref is not an
// identifier at all (an id), which is what tells a lookup which of the two indexes to use.
export function parseIssueIdentifier(ref: string): string | undefined {
  return ISSUE_IDENTIFIER_PATTERN.test(ref) ? ref.toUpperCase() : undefined;
}

// The key is also how a TEAM is addressed — `GET /teams/ENG`, `/{workspace}/teams/ENG/issues` — for the same
// reason the identifier addresses an issue: a team's URL should read as the name people use for it. Accepted
// case-insensitively (a lowercased URL still resolves) and unambiguous against an id, since a uuid is 36
// characters and this shape is at most 6.
export const TEAM_KEY_REF_PATTERN = /^[A-Za-z][A-Za-z0-9]{1,5}$/;

// The stored form of a team reference a caller typed: `eng` → `ENG`. Returns undefined when the ref cannot be a
// key at all (an id), which is what tells a lookup which of the two indexes to use.
export function parseTeamKey(ref: string): string | undefined {
  return TEAM_KEY_REF_PATTERN.test(ref) ? ref.toUpperCase() : undefined;
}
