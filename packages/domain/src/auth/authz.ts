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
  // Workspace Skills — SKILL.md-style procedures members author for the conversational agent. Collaborative content
  // like comments/datasets: read viewer+, write (create/edit/share) member+; delete = creator-or-admin (service layer).
  | "skills:read"
  | "skills:write"
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
  // Minting workspace image-registry push credentials — the only member action where a credential 'value' leaves to the caller,
  // so it's honestly named as a separate action instead of reusing harnesses:register (viewer+) (register/unregister = settings:write, read = harnesses:read).
  | "images:push";

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
    "skills:read", // reading the workspace skill library is benign → viewer+
    "runtimes:read",
    "runtimes:write", // runtime registration (+validate/probe) is role-independent — every member registers their own workspace's execution infra (same as harnesses:register)
    "members:read", // reading the team (workspace members) is benign → viewer+
    "comments:read", // reading comments = benign (viewing collaborative discussion) → viewer+
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
    "agents:write", // agent config = eval-authoring content (how the workspace's assistant behaves) → member+ like models/judges
    "skills:read",
    "skills:write", // authoring/sharing a workspace skill = collaborative content → member+ (delete = creator-or-admin, service layer)
    "runtimes:read",
    "runtimes:write", // runtime registration (+validate/probe) is role-independent
    "members:read",
    "comments:read",
    "comments:write", // writing comments = collaborative content (discussing which model was run) → member+ (deletion = author-or-admin, service layer)
    "images:push", // workspace registry push credential — harness authoring (image publishing) is a member's job
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
    "agents:write",
    "skills:read",
    "skills:write",
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
    "images:push",
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
  "skills:read",
  "runtimes:read",
  "members:read",
  "comments:read",
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
  "runtimes:write",
  "comments:write",
  "images:push", // image publishing = part of harness authoring (a credential scoped to one's own workspace registry)
];
// admin scope (= Full Access) = every action. Derived from the union of the role matrix (the admin role holds all).
const ALL_ACTIONS = new Set<Action>(Object.values(ROLE_PERMISSIONS).flatMap((s) => [...s]));

const SCOPE_PERMISSIONS: Record<string, ReadonlySet<Action>> = {
  read: new Set<Action>(SCOPE_READ_ACTIONS),
  write: new Set<Action>(SCOPE_WRITE_ACTIONS),
  admin: ALL_ACTIONS,
};

export function can(principal: Principal, action: Action): boolean {
  const roleOk = principal.roles.some((r) => ROLE_PERMISSIONS[r]?.has(action) ?? false);
  if (!roleOk) return false;
  // A subject with no scope (OIDC user / legacy key) keeps the role permissions as-is (unlimited). If scoped, narrowed by intersection.
  if (!principal.scopes || principal.scopes.length === 0) return true;
  return principal.scopes.some((s) => SCOPE_PERMISSIONS[s]?.has(action) ?? false);
}

// 403 if not permitted. The caller (API route) invokes this at handler entry.
export function authorize(principal: Principal, action: Action): void {
  if (!can(principal, action)) {
    throw new ForbiddenError(
      "FORBIDDEN",
      { workspace: principal.workspace, roles: principal.roles, action },
      `You do not have permission for this action (${action}).`,
    );
  }
}
