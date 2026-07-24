// S6 policy (docs/architecture/agent-teams.md) — the curated allowlist of eval-DRIVING control-plane actions the agent
// may perform when write capability is opted in (AGENT_ALLOW_EVAL_DRIVE). It mirrors the existing INTEGRATION_ACTIONS
// pattern in mcp-tools.ts: an action is bridged isReadOnly:false so every call passes the HITL/plan/rule permission
// gate. This module is the SSOT for that set + the hard exclusions; wiring it into the base-tool allowlist is a small
// change in mcp-tools.ts (admit EVAL_ACTIONS when eval-drive is on) done when that file's in-flight refactor lands.
//
// The agent always acts as its authenticated principal, so the control-plane RBAC is the real backstop — this allowlist
// is intentional scoping + defense-in-depth (the agent never even *sees* a destructive/governance verb by default).

// Eval-driving actions: run/manage evals, author harnesses/datasets/judges/models/runtimes, schedule, import, view.
export const EVAL_ACTIONS = new Set<string>([
  // runs & scorecards
  "run_scorecard",
  "retry_scorecard",
  "rerun_scorecard",
  "cancel_scorecard",
  "ingest_scorecard",
  "pull_scorecard",
  "submit_run",
  "backfill_scorecard_models",
  // harness / dataset / judge / model / runtime authoring
  "register_harness",
  "register_harness_template",
  "pin_harness_images",
  "create_dataset",
  "create_judge",
  "create_model",
  "create_runtime",
  "set_harness_version_tags",
  "set_dataset_version_tags",
  "set_judge_version_tags",
  "set_model_version_tags",
  "set_runtime_version_tags",
  "assign_harness_trace_source",
  "assign_harness_trace_sink",
  "set_harness_span_attr_mapping",
  // scheduling / ops / import / view
  "create_schedule",
  "update_schedule",
  "control_runtime",
  "import_benchmark",
  "import_harbor",
  "import_terminal_bench",
  "apply_bundle",
  "create_view",
  "create_comment",
]);

// Verbs the agent must NEVER perform, even with eval-drive on — destructive, governance, secret, or credential-minting.
// Encoded as prefixes + exact names so it also serves as a guard/assertion against anything wrongly added to the set.
const FORBIDDEN_PREFIXES = ["delete_", "remove_", "revoke_", "unlink_", "set_workspace_", "pair_", "github_"];
const FORBIDDEN_NAMES = new Set<string>([
  "set_secret",
  "create_workspace",
  "delete_workspace",
  "update_workspace",
  "leave_workspace",
  "set_member_role",
  "create_api_key",
  "create_invite",
  "accept_invite",
  "link_ci_repository",
  "set_budget_limit",
]);

export function isForbiddenAgentAction(name: string): boolean {
  return FORBIDDEN_PREFIXES.some((p) => name.startsWith(p)) || FORBIDDEN_NAMES.has(name);
}

// An action the agent may drive under eval-drive: in the curated set AND not forbidden (belt-and-suspenders).
export function isEvalDrivingAction(name: string): boolean {
  return EVAL_ACTIONS.has(name) && !isForbiddenAgentAction(name);
}
