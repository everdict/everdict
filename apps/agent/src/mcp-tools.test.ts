import { describe, expect, it } from "vitest";
import { isBaseToolReadOnly, isDefaultBaseTool } from "./mcp-tools.js";

// The base control-plane surface is bridge-all: every entity's reads AND mutations reach the agent, and safety lives
// in the layers (RBAC + the session's permission mode over the gate), not in surface shaping. These predicates are
// the SSOT for what is bridged and which calls skip the permission gate.
describe("base tool default wiring", () => {
  it("bridges reads and mutations alike (the whole catalog is the default surface)", () => {
    for (const name of [
      // reads
      "list_ci_links",
      "get_workspace_mattermost",
      "inspect_trace",
      "list_workspace_image_registries",
      // integration actions
      "post_mattermost_message",
      "open_ci_setup_pr",
      "create_github_issue",
      "open_github_pr",
      // eval-driving mutations (previously behind the eval-drive opt-in)
      "run_scorecard",
      "create_dataset",
      "pin_harness_images",
      "create_schedule",
      // destructive / governance verbs — bridged too; the permission mode decides per call
      "delete_scorecard",
      "remove_member",
      "set_secret",
      "set_workspace_mattermost",
      // knowledge reads + writes
      "knowledge_related",
      "annotate_knowledge",
      "relate_knowledge",
    ])
      expect(isDefaultBaseTool(name)).toBe(true);
  });

  it("excludes only the runner wire-protocol tools from bridging", () => {
    for (const name of [
      "lease_job",
      "submit_job_result",
      "heartbeat_job",
      "fail_job",
      "report_case_log",
      "report_case_screen",
      "report_case_track",
    ])
      expect(isDefaultBaseTool(name)).toBe(false);
  });

  it("classifies pure read verbs (and the knowledge reads) as gate-skipping read-only", () => {
    for (const name of [
      "list_ci_links",
      "inspect_trace",
      "get_knowledge_node",
      "knowledge_related",
      "knowledge_subgraph",
      "knowledge_notes",
    ])
      expect(isBaseToolReadOnly(name)).toBe(true);
  });

  it("keeps every mutation permission-gated — including the credential-minting get_ read", () => {
    for (const name of [
      "get_image_push_credentials", // matches get_ but MINTS credentials
      "post_mattermost_message",
      "open_ci_setup_pr",
      "create_github_issue",
      "comment_on_github_issue",
      "open_github_pr",
      "run_scorecard",
      "delete_dataset",
      "set_secret",
      "annotate_knowledge",
      "relate_knowledge",
      "reindex_knowledge",
    ])
      expect(isBaseToolReadOnly(name)).toBe(false);
  });
});
