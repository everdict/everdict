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
      "spawn_teammate", // delegates a write-scoped execution token to an autonomous agent
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

// O4: a capability that DECLARED its effects is classified by that declaration, not by its spelling.
describe("action policy — declared effects beat the name list", () => {
  it("guards a benign-sounding capability that declared an external, non-idempotent effect", () => {
    // Given a tool whose name starts with a routine verb (pre-fix: unguarded, because "sync_" is on no list) …
    expect(isGuardedAction("sync_inventory")).toBe(false);
    // … and whose author declared that it reaches an outside system and is not safe to repeat.
    expect(
      isGuardedAction("sync_inventory", {
        sideEffect: "external",
        idempotent: false,
        rollback: { kind: "compensation", description: "issue a reversing adjustment in the vendor console" },
      }),
    ).toBe(true); // the declaration is the signal; the name never was
  });

  it("guards a workspace mutation whose idempotency is UNKNOWN — unknown is not a smaller risk", () => {
    expect(isGuardedAction("apply_thing", { sideEffect: "workspace" })).toBe(true);
    expect(isGuardedAction("apply_thing", { sideEffect: "workspace", idempotent: true })).toBe(false);
  });

  it("guards a declared-irreversible capability — the author wrote the consent requirement down", () => {
    expect(
      isGuardedAction("compact_archive", {
        sideEffect: "workspace",
        idempotent: true,
        rollback: { kind: "irreversible", requiresApproval: true },
      }),
    ).toBe(true);
  });

  it("guards a READ tool whose data can leave the boundary — sideEffect answers the wrong axis", () => {
    expect(
      isGuardedAction("summarize_docs", {
        sideEffect: "none",
        idempotent: true,
        dataAccess: { reads: "workspace", egress: "external" },
      }),
    ).toBe(true);
    // The same reader with nowhere to send it stays unguarded.
    expect(
      isGuardedAction("summarize_docs", {
        sideEffect: "none",
        idempotent: true,
        dataAccess: { reads: "workspace", egress: "none" },
      }),
    ).toBe(false);
  });

  it("trusts a declaration that says the tool is safe — even when its NAME is on the destructive list", () => {
    // A workspace adopted this thing on the strength of its declared contract; the verb it chose is not our rule.
    expect(isGuardedAction("delete_draft")).toBe(true);
    expect(isGuardedAction("delete_draft", { sideEffect: "workspace", idempotent: true })).toBe(false);
  });
});
