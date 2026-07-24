import { describe, expect, it } from "vitest";
import { EVAL_ACTIONS, isEvalDrivingAction, isForbiddenAgentAction } from "./eval-actions.js";

describe("eval-driving action allowlist (S6 policy)", () => {
  it("admits the core eval-driving verbs", () => {
    for (const name of [
      "run_scorecard",
      "retry_scorecard",
      "cancel_scorecard",
      "pin_harness_images",
      "create_dataset",
      "create_judge",
      "create_schedule",
      "apply_bundle",
    ])
      expect(isEvalDrivingAction(name)).toBe(true);
  });

  it("does not admit destructive / governance / secret verbs", () => {
    for (const name of [
      "delete_scorecard",
      "delete_harness",
      "remove_member",
      "revoke_api_key",
      "set_secret",
      "set_workspace_settings",
      "create_workspace",
      "set_member_role",
      "pair_runner",
      "github_install_workspace_runner",
      "link_ci_repository",
    ])
      expect(isEvalDrivingAction(name)).toBe(false);
  });

  it("flags forbidden verbs by prefix and by exact name", () => {
    expect(isForbiddenAgentAction("delete_dataset")).toBe(true);
    expect(isForbiddenAgentAction("set_workspace_mattermost")).toBe(true);
    expect(isForbiddenAgentAction("set_secret")).toBe(true);
    expect(isForbiddenAgentAction("run_scorecard")).toBe(false);
  });

  it("keeps the invariant that no eval action is also forbidden (the two sets are disjoint)", () => {
    for (const name of EVAL_ACTIONS) expect(isForbiddenAgentAction(name)).toBe(false);
  });
});
