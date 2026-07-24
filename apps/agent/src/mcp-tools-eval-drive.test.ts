import { describe, expect, it } from "vitest";
import { isBaseToolReadOnly, isDefaultBaseTool } from "./mcp-tools.js";

// S6 (docs/architecture/agent-teams.md): the agent can be opted into DRIVING eval, which admits the curated
// eval-driving write tools beyond the default read-only + integration surface — each still HITL/plan/rule-gated.
describe("eval-drive tool admission (S6)", () => {
  it("keeps eval-driving write tools OUT of the default (read-only) surface", () => {
    for (const name of ["run_scorecard", "pin_harness_images", "create_dataset", "create_schedule"])
      expect(isDefaultBaseTool(name)).toBe(false); // flag defaults off → read-only agent
  });

  it("admits eval-driving write tools only when eval-drive is on, and they are never read-only (HITL-gated)", () => {
    for (const name of ["run_scorecard", "pin_harness_images", "create_dataset", "create_schedule"]) {
      expect(isDefaultBaseTool(name, true)).toBe(true);
      expect(isBaseToolReadOnly(name)).toBe(false);
    }
  });

  it("never admits destructive / governance / secret verbs, even with eval-drive on", () => {
    for (const name of [
      "delete_scorecard",
      "delete_harness",
      "remove_member",
      "revoke_api_key",
      "set_secret",
      "set_workspace_settings",
      "create_workspace",
    ])
      expect(isDefaultBaseTool(name, true)).toBe(false);
  });

  it("leaves read verbs and integration actions unaffected by the flag", () => {
    expect(isDefaultBaseTool("get_scorecard")).toBe(true);
    expect(isDefaultBaseTool("post_mattermost_message")).toBe(true);
    expect(isBaseToolReadOnly("get_scorecard")).toBe(true);
  });
});
