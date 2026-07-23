import { describe, expect, it } from "vitest";
import { USE_SKILL_TOOL_NAME, buildSkillTool } from "./skill-tool.js";

const skills = [
  { name: "scorecard-triage", description: "Summarize a scorecard's failures", instructions: "1. get_scorecard\n2. …" },
  { name: "harness-review", description: "Review a harness spec", instructions: "1. get_harness_instance\n2. …" },
];

describe("buildSkillTool", () => {
  it("returns undefined when the workspace has no skills", () => {
    expect(buildSkillTool([])).toBeUndefined();
  });

  it("is a native always-loaded read-only tool that lists every skill in its description", () => {
    const tool = buildSkillTool(skills);
    expect(tool?.name).toBe(USE_SKILL_TOOL_NAME);
    expect(tool?.alwaysLoad).toBe(true);
    expect(tool?.isReadOnly).toBe(true);
    expect(tool?.isMcp).toBeUndefined(); // not deferred behind ToolSearch
    expect(tool?.description).toContain("scorecard-triage: Summarize a scorecard's failures");
    expect(tool?.description).toContain("harness-review: Review a harness spec");
    const schema = tool?.parametersJsonSchema as { properties: { skill: { enum: string[] } } };
    expect(schema.properties.skill.enum).toEqual(["scorecard-triage", "harness-review"]);
  });

  it("loads the chosen skill's full instructions on call", async () => {
    const tool = buildSkillTool(skills);
    const result = await tool?.call({ skill: "scorecard-triage" }, {});
    expect(result?.isError).toBe(false);
    expect(result?.content).toContain("# Skill: scorecard-triage");
    expect(result?.content).toContain("1. get_scorecard");
  });

  it("returns an error for an unknown skill name", async () => {
    const tool = buildSkillTool(skills);
    const result = await tool?.call({ skill: "nope" }, {});
    expect(result?.isError).toBe(true);
    expect(result?.content).toContain("No such skill");
    expect(result?.content).toContain("scorecard-triage, harness-review");
  });
});
