import { describe, expect, it } from "vitest";
import { isBaseToolReadOnly, isDefaultBaseTool } from "./mcp-tools.js";

// The base control-plane surface reaches the agent through a default-deny allowlist: read verbs plus a curated set
// of "use the integration" actions. These predicates are the SSOT for what a workspace's configured integrations
// expose to the conversational agent by default, and which of those calls the HITL permission gate approves inline.
describe("base tool default wiring", () => {
  it("bridges read verbs", () => {
    for (const name of [
      "list_ci_links",
      "get_workspace_mattermost",
      "inspect_trace",
      "list_workspace_image_registries",
    ])
      expect(isDefaultBaseTool(name)).toBe(true);
  });

  it("bridges the curated integration actions (so configured integrations are usable by default)", () => {
    for (const name of ["post_mattermost_message", "open_ci_setup_pr", "get_image_push_credentials"])
      expect(isDefaultBaseTool(name)).toBe(true);
  });

  it("excludes config/register/destroy and secret-write tools (default-deny holds)", () => {
    for (const name of [
      "set_workspace_mattermost",
      "remove_workspace_trace_source",
      "assign_harness_trace_source",
      "link_ci_repository",
      "start_workspace_github_app_install",
      "set_secret",
      "delete_secret",
    ])
      expect(isDefaultBaseTool(name)).toBe(false);
  });

  it("HITL-gates the integration actions but not plain reads", () => {
    // Pure read verbs skip the gate.
    expect(isBaseToolReadOnly("list_ci_links")).toBe(true);
    expect(isBaseToolReadOnly("inspect_trace")).toBe(true);
    // The actions are gated — including get_image_push_credentials, which matches get_ but MINTS credentials.
    expect(isBaseToolReadOnly("post_mattermost_message")).toBe(false);
    expect(isBaseToolReadOnly("open_ci_setup_pr")).toBe(false);
    expect(isBaseToolReadOnly("get_image_push_credentials")).toBe(false);
  });
});
