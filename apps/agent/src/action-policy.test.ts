import { describe, expect, it } from "vitest";
import { isGuardedAction, isProtocolTool } from "./action-policy.js";

describe("action policy (bridge-all surface)", () => {
  it("classifies the runner wire-protocol tools (never member actions, excluded from bridging)", () => {
    for (const name of [
      "lease_job",
      "submit_job_result",
      "heartbeat_job",
      "fail_job",
      "report_case_log",
      "report_case_screen",
      "report_case_track",
    ])
      expect(isProtocolTool(name)).toBe(true);
    for (const name of ["run_scorecard", "get_run", "delete_dataset"]) expect(isProtocolTool(name)).toBe(false);
  });

  it("guards destructive verbs (still ask in auto mode)", () => {
    for (const name of [
      "delete_scorecard",
      "delete_harness",
      "remove_member",
      "revoke_api_key",
      "unlink_ci_repository",
    ])
      expect(isGuardedAction(name)).toBe(true);
  });

  it("guards governance / credential / billing actions", () => {
    for (const name of [
      "set_secret",
      "create_api_key",
      "create_invite",
      "accept_invite",
      "set_member_role",
      "leave_workspace",
      "create_workspace",
      "update_workspace",
      "set_budget_limit",
      "pair_runner",
      "pair_workspace_runner",
      "github_install_workspace_runner",
    ])
      expect(isGuardedAction(name)).toBe(true);
  });

  it("leaves routine eval-driving and integration mutations unguarded (auto mode runs them without asking)", () => {
    for (const name of [
      "run_scorecard",
      "retry_scorecard",
      "cancel_scorecard",
      "create_dataset",
      "create_judge",
      "register_harness",
      "pin_harness_images",
      "create_schedule",
      "update_schedule",
      "apply_bundle",
      "open_github_pr",
      "create_github_issue",
      "post_mattermost_message",
      "set_workspace_mattermost",
      "annotate_knowledge",
    ])
      expect(isGuardedAction(name)).toBe(false);
  });
});
