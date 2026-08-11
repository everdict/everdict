import type { EffectContract } from "@everdict/contracts";
import { effectsRequireConsent } from "@everdict/domain";

// The conversational agent's base-surface policy — the WHOLE control-plane MCP catalog is bridged so the agent can
// act on every everdict entity (create / run / update / delete / configure) as its authenticated principal. Three
// enforcement layers stand in front of every mutation:
//   1. control-plane RBAC — the agent calls as the member; a role that can't do it server-side still can't.
//   2. the HITL permission gate — a non-read tool call is decided by the session's PERMISSION MODE (server.ts):
//      "default" asks the member for every mutation · "auto" auto-allows routine mutations but still asks for the
//      GUARDED ones below · "bypass" never asks (the member's explicit standing choice) · "plan" stays read-only
//      until the presented plan is approved. Session rules ("always allow/deny this tool") short-circuit all of it.
//   3. this module — the two static classifications the surface needs: the runner WIRE-PROTOCOL tools that are never
//      member actions (excluded from bridging entirely), and the guarded actions that keep asking in "auto".
// Supersedes the S6 eval-drive opt-in (AGENT_ALLOW_EVAL_DRIVE + its curated allowlist): eval-driving mutations are
// part of the default surface now — safety moved from "the agent never sees the verb" to "the member's permission
// mode decides per call". See docs/architecture/agent-conversations.md.

// Runner wire-protocol tools (the self-hosted runner ↔ control-plane lease loop). Machine protocol, not member
// actions — the server rejects non-runner principals on them anyway; bridging them would only add catalog noise.
const PROTOCOL_TOOLS = new Set<string>([
  "lease_job",
  "submit_job_result",
  "heartbeat_job",
  "fail_job",
  "report_case_log",
  "report_case_screen",
  "report_case_track",
]);

export function isProtocolTool(name: string): boolean {
  return PROTOCOL_TOOLS.has(name);
}

// Guarded actions — destructive (irreversible loss) or governance/credential (access, membership, billing) mutations.
// In "auto" mode these still prompt the member; every other mutation auto-allows. Encoded as verb prefixes + exact
// names (the same encoding the retired eval-drive FORBIDDEN list used, so nothing silently falls out of the class).
const GUARDED_PREFIXES = ["delete_", "remove_", "revoke_", "unlink_"];
const GUARDED_NAMES = new Set<string>([
  "set_secret", // writes a secret value through the chat
  "create_api_key", // mints a credential
  "create_invite", // membership governance …
  "accept_invite",
  "set_member_role",
  "leave_workspace",
  "create_workspace", // workspace governance …
  "update_workspace",
  "set_budget_limit", // billing envelope
  "pair_runner", // device/runner credential minting …
  "pair_workspace_runner",
  "github_install_workspace_runner",
  // Agent worlds (W2): a session push mints a write credential against the workspace's GitHub App and lands
  // code on a real remote. `sandbox_exec` stays unguarded — a container is the agent's own scratch space —
  // but the moment its contents leave for a repository, that is a governed write like any other.
  "sandbox_git_push",
  // Same reasoning one step earlier in the pipeline: committing straight to a branch lands code on a real
  // repository with NO review step in between (open_github_pr stays unguarded precisely because a PR is a
  // proposal somebody still has to accept). Naming the default branch here ships to production's source.
  "commit_github_files",
  // native (non-MCP) kernel tool — spawning a persistent teammate mints it a write-scoped execution token and it
  // then acts autonomously with no human channel, so the delegation itself stays consented even in auto mode.
  "spawn_teammate",
]);

// Guarded classification, in order of what we actually KNOW:
//
//   ① the capability's own EffectContract, when the tool came from one. This is the honest answer — the
//      author declared the blast radius at save time (the domain guard refuses a write-capable capability
//      that does not), and reading it beats guessing. `sync_inventory` looks benign and can bill a customer;
//      `remove_label` looks alarming and undoes itself. Spelling was never the signal.
//   ② the verb-prefix + exact-name lists below, for everything with no declaration behind it: the built-in
//      control-plane surface and the kernel's own tools, which are ours and known rather than declared.
//
// A declared contract does NOT lose to the name list: a capability that says it is safe is trusted on its own
// statement, because that statement is what the workspace signed up for when it adopted the thing. The name
// lists stay authoritative only where nobody made a statement at all.
export function isGuardedAction(name: string, effects?: EffectContract): boolean {
  if (effects) return effectsRequireConsent(effects);
  return GUARDED_PREFIXES.some((p) => name.startsWith(p)) || GUARDED_NAMES.has(name);
}
