import { ForbiddenError } from "@everdict/contracts";
import type { Principal } from "./principal.js";

// Role within a workspace → action permission. The control plane enforces this per endpoint (authZ).
// harnesses:register (instance) / templates:write (template category) are open to anyone (viewer+) — a harness is collaborative
// eval content, so there's no role gate (equal use regardless of permission).
// Connected accounts are not in this matrix — like a profile they're personally owned (owner=subject), so they're self-scoped
// by subject, not by role (the route scopes directly by principal.subject; no connections:* action).
export type Action =
  | "runs:read"
  | "runs:submit"
  | "harnesses:read"
  | "harnesses:register"
  | "templates:write"
  | "datasets:read"
  | "datasets:write"
  | "datasets:delete"
  | "harnesses:delete"
  | "scorecards:read"
  | "scorecards:run"
  | "scorecards:delete"
  | "schedules:read"
  | "schedules:write"
  | "judges:read"
  | "judges:write"
  | "judges:delete"
  | "models:read"
  | "models:write"
  | "models:delete"
  // Workspace agent configuration (instructions + MCP tool servers + model powering the conversational agent).
  // Same shape as models: read viewer+, write member+ (eval-authoring content), delete admin+ (creator exception in the service).
  | "agents:read"
  | "agents:write"
  | "agents:delete"
  // Platform-event log (agent-automation A1) — lifecycle FACTS. Reading is benign observability (the fleet's
  // event feed + the crafting studio's replay picker) → viewer+. Events are emitted by the system, never written
  // through the API, so there is no events:write.
  | "events:read"
  // Workspace Skills — SKILL.md-style procedures members author for the conversational agent. Collaborative content
  // like comments/datasets: read viewer+, write (create/edit/share) member+; delete = creator-or-admin (service layer).
  | "skills:read"
  | "skills:write"
  // The workspace filesystem — the shared, workspace-isolated file tree (agent task outputs, artifacts, skill/knowledge
  // bodies). Browsing/reading is benign → viewer+; writing (files, dirs, moves, removals) = collaborative content →
  // member+ like datasets/skills. No files:delete — removal is ordinary content mutation, not governance.
  | "files:read"
  | "files:write"
  // Capability Store — one discriminated entity (mcp|code|skill) members author, publish (private|workspace|subset|
  // public), and adopt into their agent. Collaborative content like agents/skills: read viewer+, write member+;
  // delete = creator-or-admin (service). Promoting reach to `public` additionally requires admin (service-enforced,
  // like the View visibility gate) — no separate action, to avoid knob proliferation.
  | "capabilities:read"
  | "capabilities:write"
  | "capabilities:delete"
  | "runtimes:read"
  | "runtimes:write"
  // Destructive live-cluster control (stop a running workload / reclaim idle / purge terminal jobs / cordon a node) —
  // admin-only, unlike runtimes:write (viewer+ registration). Aborting an in-flight eval or taking a node out of
  // scheduling is operator governance, not authoring; also admin-scope-only for keys (not in read/write scope).
  | "runtimes:control"
  | "secrets:read"
  | "secrets:write"
  | "keys:read"
  | "keys:write"
  | "members:read"
  | "members:write"
  | "settings:read"
  | "settings:write"
  | "comments:read"
  | "comments:write"
  // The eval tracker (issues + projects + initiatives, docs/tracker.md) — ONE action pair for all three, because
  // they are one workflow: an issue only means something inside its project, and a project only inside its
  // initiative. Read viewer+ (knowing what the team is evaluating is benign), write member+ (collaborative
  // content like datasets/comments). No issues:delete — removal is ordinary content mutation, gated
  // creator-or-admin in the service, like skills and comments.
  | "issues:read"
  | "issues:write"
  // Teams (records/team.ts) shape the workspace rather than fill it: creating one mints an identifier prefix
  // every future issue inherits, and the roster decides whose list an issue lands in. That is administration,
  // so it does not ride issues:write (member+) the way tracker CONTENT does — read stays viewer+ because
  // knowing the teams is as benign as knowing the members.
  | "teams:read"
  | "teams:write"
  // Joining/leaving a team YOURSELF (Linear's "Join teams"). Deliberately split from teams:write: managing
  // someone else's roster is workspace administration, but putting yourself on a public team is how a member
  // subscribes to a stream of work — honestly named as its own action (like images:push) rather than widening
  // teams:write to member. The route only ever passes the caller's own subject, so the action cannot reach
  // anyone else's membership. Viewer stays out: a read-only role does not mutate rosters.
  | "teams:join"
  // Minting workspace image-registry push credentials — the only member action where a credential 'value' leaves to the caller,
  // so it's honestly named as a separate action instead of reusing harnesses:register (viewer+) (register/unregister = settings:write, read = harnesses:read).
  | "images:push"
  // Posting a message to the workspace's configured Mattermost channel (the conversational agent's post_mattermost_message
  // tool + its HTTP/MCP endpoint). A member-level runtime action = USING the integration, honestly named as its own action
  // (like images:push) rather than reusing settings:write — that REGISTERS the bot (admin governance). A member can have the
  // agent notify the team without being able to reconfigure the integration.
  | "mattermost:post"
  // Reading through the workspace GitHub App — which repositories the installation covers, a file's content, a repo's
  // file tree, the issue list (the conversational agent's list_github_app_repos / get_github_file / list_github_repo_files /
  // list_github_issues tools). USING the integration, exactly like github:write below, so it sits at the same member+ level:
  // reads used to ride settings:read, which is ADMIN-ONLY, so a member-role agent could open a pull request against a repo
  // it was not allowed to read first — write without read. Not viewer+ like other reads: this reaches OUTSIDE the workspace,
  // into private source the org installed the App on, and "use the integration" is a member's job on both halves.
  | "github:read"
  // Using the workspace GitHub App to create an issue or add a comment (the conversational agent's create_github_issue /
  // comment_on_github_issue tools). A member-level runtime action = USING the integration (like mattermost:post), not the
  // admin-only App registration (settings:write). Its read twin is github:read.
  | "github:write";

export const EVERDICT_ROLES = ["viewer", "member", "admin"] as const;
export type EverdictRole = (typeof EVERDICT_ROLES)[number];

const ROLE_PERMISSIONS: Record<string, ReadonlySet<Action>> = {
  viewer: new Set<Action>([
    "runs:read",
    "harnesses:read",
    "harnesses:register", // anyone can register (no role gate — collaborative eval content)
    "templates:write", // template (category) definition is the same — anyone (equal regardless of permission)
    "datasets:read",
    "scorecards:read",
    "schedules:read", // reading schedules is benign (same as reading scorecards) → viewer+
    "judges:read",
    "models:read",
    "agents:read", // reading the workspace agent config is benign → viewer+
    "events:read", // reading the platform-event log is benign observability → viewer+
    "skills:read", // reading the workspace skill library is benign → viewer+
    "files:read", // browsing/reading the workspace filesystem is benign → viewer+
    "capabilities:read", // browsing the Capability Store (own + shared + public) is benign → viewer+
    "runtimes:read",
    "runtimes:write", // runtime registration (+validate/probe) is role-independent — every member registers their own workspace's execution infra (same as harnesses:register)
    "members:read", // reading the team (workspace members) is benign → viewer+
    "comments:read", // reading comments = benign (viewing collaborative discussion) → viewer+
    "issues:read", // reading the tracker (what the team is evaluating and why) is benign → viewer+
    "teams:read", // knowing which teams exist is as benign as knowing the members → viewer+
  ]),
  member: new Set<Action>([
    "runs:read",
    "runs:submit",
    "harnesses:read",
    "harnesses:register",
    "templates:write",
    "datasets:read",
    "datasets:write",
    "scorecards:read",
    "scorecards:run",
    "schedules:read",
    "schedules:write", // creating a schedule = committing to recurring runs (budget spend) → member+ like scorecards:run
    "judges:read",
    "judges:write",
    "models:read",
    "models:write", // model definition = eval content (which model was run) → member-allowed like judges/datasets
    "agents:read",
    "events:read",
    "agents:write", // agent config = eval-authoring content (how the workspace's assistant behaves) → member+ like models/judges
    "skills:read",
    "skills:write", // authoring/sharing a workspace skill = collaborative content → member+ (delete = creator-or-admin, service layer)
    "files:read",
    "files:write", // writing to the workspace filesystem = collaborative content → member+ like datasets/skills
    "capabilities:read",
    "capabilities:write", // authoring/publishing/adopting a capability = collaborative content → member+ (public promotion + delete gated in the service)
    "runtimes:read",
    "runtimes:write", // runtime registration (+validate/probe) is role-independent
    "members:read",
    "comments:read",
    "comments:write", // writing comments = collaborative content (discussing which model was run) → member+ (deletion = author-or-admin, service layer)
    "issues:read",
    "issues:write", // filing/resolving/linking tracker work = collaborative content → member+ (deletion = creator-or-admin, service layer)
    "teams:read", // a member files into a team, so it must be able to list them (creating one stays admin)
    "teams:join", // putting YOURSELF on (or off) a public team's roster — self-service, never someone else's membership
    "images:push", // workspace registry push credential — harness authoring (image publishing) is a member's job
    "mattermost:post", // posting to the workspace Mattermost channel (using the integration) — a member's job, unlike admin-only registration (settings:write)
    "github:read", // reading repos/files/issues via the workspace App (using the integration) — the read half of github:write, same level: a role that may open a PR must be able to read what it is changing
    "github:write", // creating a GitHub issue/comment via the workspace App (using the integration) — a member's job, unlike admin-only App registration (settings:write)
  ]),
  // GitHub Actions OIDC federation (via=github-actions) only — the minimum CI needs:
  // fire/poll/diff (scorecards) + re-pin (harnesses:register)/baseline read (harnesses:read). No governance/secrets/members.
  ci: new Set<Action>(["scorecards:read", "scorecards:run", "harnesses:read", "harnesses:register"]),
  admin: new Set<Action>([
    "runs:read",
    "runs:submit",
    "harnesses:read",
    "harnesses:register",
    "templates:write",
    "datasets:read",
    "datasets:write",
    "datasets:delete", // dataset version soft-delete — admin-only (the creator is separately overridden in the service). member/viewer don't have it
    "harnesses:delete", // harness version soft-delete — same pattern (admin-only + creator exception in the service layer)
    "models:delete", // model version soft-delete — same pattern (admin-only + creator exception in the service layer)
    "agents:delete", // agent config version soft-delete — same pattern (admin-only + creator exception in the service layer)
    "judges:delete", // judge version soft-delete — same pattern (admin-only + creator exception in the service layer)
    "scorecards:read",
    "scorecards:run",
    "scorecards:delete", // scorecard hard-delete (record + child runs) — admin-only + creator exception in the service layer
    "schedules:read",
    "schedules:write",
    "judges:read",
    "judges:write",
    "models:read",
    "models:write",
    "agents:read",
    "events:read",
    "agents:write",
    "skills:read",
    "skills:write",
    "files:read",
    "files:write",
    "capabilities:read",
    "capabilities:write",
    "capabilities:delete", // capability version soft-delete — admin-only + creator exception in the service layer
    "runtimes:read",
    "runtimes:write", // runtime registration is role-independent (viewer/member have it too) — the credential 'value' is separately protected by secrets:write (admin)
    "runtimes:control", // destructive live-cluster control (stop workload / reclaim idle / purge / cordon) — admin-only
    "secrets:read", // secrets (provider keys) are powerful → admin-only
    "secrets:write",
    "keys:read", // an API key holds workspace admin permission at issuance → issue/revoke is admin-only (same rationale as secrets)
    "keys:write",
    "members:read",
    "members:write", // member role change/removal/invite issuance = governance (including issuing admin invites) → admin-only
    "settings:read", // workspace policy (instrumentation, etc.) = admin-only settings
    "settings:write",
    "comments:read",
    "comments:write",
    "issues:read",
    "issues:write",
    "teams:read",
    "teams:write", // creating a team mints an identifier prefix + decides whose list issues land in → workspace administration
    "teams:join",
    "images:push",
    "mattermost:post",
    "github:read",
    "github:write",
  ]),
};

// --- Per-api-key permission scope — Linear-style "Full Access vs selected permissions" ---
// A key holds the workspace admin role at issuance, but scope can further narrow that key's permissions.
// Scope is applied as an "intersection" with the role permissions (see can) — a scoped key never exceeds its own role.
// Cumulative: admin ⊃ write ⊃ read. admin scope = Full Access. The authz matrix is the SSOT for scope→action.
export const API_KEY_SCOPES = ["read", "write", "admin"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

// read scope = "reading workspace data" — excludes sensitive reads (secrets/keys/settings) (admin scope required).
const SCOPE_READ_ACTIONS: readonly Action[] = [
  "runs:read",
  "harnesses:read",
  "datasets:read",
  "scorecards:read",
  "schedules:read",
  "judges:read",
  "models:read",
  "agents:read",
  "events:read",
  "skills:read",
  "files:read",
  "capabilities:read",
  "runtimes:read",
  "members:read",
  "comments:read",
  "issues:read",
  "github:read", // reading repos/files/issues through the workspace App = reading, not governance (unlike secrets/keys/settings). Its write twin rides the write scope below
];
// write scope = read ∪ content mutation (submit runs, register, create versions, run). Governance (secrets/members/settings/keys write, datasets:delete) is admin-scope only.
const SCOPE_WRITE_ACTIONS: readonly Action[] = [
  ...SCOPE_READ_ACTIONS,
  "runs:submit",
  "harnesses:register",
  "templates:write",
  "datasets:write",
  "scorecards:run",
  "schedules:write",
  "judges:write",
  "models:write",
  "agents:write",
  "skills:write",
  "files:write",
  "capabilities:write",
  "runtimes:write",
  "comments:write",
  "issues:write", // filing/resolving tracker work = content mutation (an agent triaging its own regressions needs it)
  "teams:join", // joining/leaving a team oneself = subscribing to a stream of work, not roster governance
  "images:push", // image publishing = part of harness authoring (a credential scoped to one's own workspace registry)
  "mattermost:post", // posting to the workspace Mattermost channel = content mutation (using a configured integration)
  "github:write", // creating a GitHub issue/comment via the workspace App = content mutation (using a configured integration)
];
// admin scope (= Full Access) = every action. Derived from the union of the role matrix (the admin role holds all).
const ALL_ACTIONS = new Set<Action>(Object.values(ROLE_PERMISSIONS).flatMap((s) => [...s]));

const SCOPE_PERMISSIONS: Record<string, ReadonlySet<Action>> = {
  read: new Set<Action>(SCOPE_READ_ACTIONS),
  write: new Set<Action>(SCOPE_WRITE_ACTIONS),
  admin: ALL_ACTIONS,
};

// The resource an action is aimed at, when the answer depends on it. Today that is TEAM OWNERSHIP: an eval asset
// (harness · dataset · judge · rubric · runtime · scorecard · view · schedule) and an issue belong to a team, and
// a team's work is ITS OWN — reading it as well as writing it. Omit the scope for workspace-level actions
// (settings, members, secrets), which have no owner to check.
export interface ResourceScope {
  // The owning team. `undefined` = the resource declares no owner (legacy rows, `_shared` seeds, workspace-level
  // assets) and the team check does not apply — "no owner" means the workspace's, and it is a real state, not a
  // gap: it is what every row was before the axis existed and what every seeded catalogue entry still is.
  teamId?: string;
}

// A machine credential is not a person, and the team axis is a roster of people: a paired runner device and a
// repo-linked CI token act for the WORKSPACE that trusts them, hold a deliberately tiny role, and can never be
// added to a team — isolating them by one would just mean "sees nothing". An agent credential is the opposite
// case and is NOT listed here: it acts AS its creator, so it carries that person's teams and is isolated with them.
function actsForWorkspace(principal: Principal): boolean {
  return principal.via === "runner" || principal.via === "github-actions";
}

// Is this a write? The two halves of the team axis ask different questions, and conflating them was a bug:
//
//   · WRITING another team's asset is refused — a team's work is theirs to change, and membership is the roster
//     that says who "they" are. That is what this kernel can answer, because the principal carries its teams.
//   · READING is not membership's business. A workspace whose teams cannot see each other's work has stopped
//     being one workspace, so the default is visible and the narrowing is TEAM PRIVACY (`isPrivate`) — an
//     explicit, per-team opt-in. Privacy is a property of the TEAM, which a pure kernel cannot look up, so it is
//     enforced where the roster is (`TeamService.visibleTeamIds` / `canSeeTeam` — the one place that decides it)
//     and answered 404, never 403.
function isWrite(action: Action): boolean {
  return !action.endsWith(":read");
}

// `can` answers three questions in order, and all three must pass:
//   1. does the ROLE grant this action  2. does the api-key SCOPE still carry it  3. may this subject reach THIS
//      resource — i.e. is the owning team one of theirs.
// (3) is the team axis. An ADMIN bypasses it: admins govern the whole workspace, and a team they are not on would
// otherwise be un-administrable — the same reason workspace settings are admin-only in the first place.
export function can(principal: Principal, action: Action, resource?: ResourceScope): boolean {
  const roleOk = principal.roles.some((r) => ROLE_PERMISSIONS[r]?.has(action) ?? false);
  if (!roleOk) return false;
  // A subject with no scope (OIDC user / legacy key) keeps the role permissions as-is (unlimited). If scoped, narrowed by intersection.
  if (principal.scopes && principal.scopes.length > 0) {
    if (!principal.scopes.some((s) => SCOPE_PERMISSIONS[s]?.has(action) ?? false)) return false;
  }
  return canReachTeam(principal, action, resource);
}

// The team half, split out so a service that already knows the role passed can ask just this. See `isWrite`:
// this is the WRITE half — reads pass here and are narrowed by team privacy at the transport instead.
export function canReachTeam(principal: Principal, action: Action, resource?: ResourceScope): boolean {
  if (resource?.teamId === undefined) return true; // unowned / workspace-level → nothing to check
  if (!isWrite(action)) return true; // reads are decided by team PRIVACY, not by the roster
  if (principal.roles.includes("admin")) return true; // an admin governs every team in the workspace
  if (actsForWorkspace(principal)) return true; // a runner/CI credential has no roster to be isolated by
  return principal.teams?.includes(resource.teamId) ?? false;
}

// The ceiling a LIST read stays under, applied to ONE already-loaded row. `teams` comes from
// `TeamService.visibleTeamIds` — the one place team privacy is decided — where `undefined` means "nothing is
// hidden" rather than "no teams". An unowned row is the workspace's and always passes.
export function ownedByVisibleTeam(owner: { teamId?: string }, teams?: string[]): boolean {
  if (teams === undefined) return true;
  if (owner.teamId === undefined) return true;
  return teams.includes(owner.teamId);
}

// The same question for a row that names SEVERAL teams (a project is worked on by all of them): it is visible
// when any one of them is, because being on one of the teams doing the work is reason enough to see it.
export function ownedByAnyVisibleTeam(owner: { teamIds?: string[] }, teams?: string[]): boolean {
  if (teams === undefined) return true;
  const owners = owner.teamIds ?? [];
  if (owners.length === 0) return true;
  return owners.some((teamId) => teams.includes(teamId));
}

// 403 if not permitted. The caller (API route) invokes this at handler entry.
export function authorize(principal: Principal, action: Action, resource?: ResourceScope): void {
  if (!can(principal, action, resource)) {
    const teamDenied = resource?.teamId !== undefined && !canReachTeam(principal, action, resource);
    throw new ForbiddenError(
      "FORBIDDEN",
      { workspace: principal.workspace, roles: principal.roles, action, ...(resource ?? {}) },
      teamDenied
        ? `This belongs to a team you are not on, so you cannot ${action}. Ask an admin to add you to the team.`
        : `You do not have permission for this action (${action}).`,
    );
  }
}
