import { describe, expect, it } from "vitest";
import { READ_SKILL_FILE_TOOL_NAME, USE_SKILL_TOOL_NAME, buildSkillTools, renderSkillListing } from "./skill-tool.js";

const skills = [
  { name: "scorecard-triage", description: "Summarize a scorecard's failures", instructions: "1. get_scorecard\n2. …" },
  { name: "harness-review", description: "Review a harness spec", instructions: "1. get_harness_instance\n2. …" },
];

const withFiles = [
  {
    name: "fix-pr",
    description: "Open a fix PR from a scorecard",
    instructions: "1. diagnose\n2. load references/pr-body.md\n3. open the PR",
    files: [
      { path: "references/pr-body.md", content: "# PR body structure\n- What failed\n- Root cause" },
      { path: "references/checklist.md", content: "- [ ] tests updated" },
    ],
  },
  ...skills,
];

describe("buildSkillTools", () => {
  it("returns no tools when the workspace has no skills", () => {
    expect(buildSkillTools([])).toEqual([]);
  });

  it("is a native always-loaded read-only tool that lists every skill in its description", () => {
    const [tool, ...rest] = buildSkillTools(skills);
    expect(rest).toEqual([]); // no files anywhere → no read_skill_file (zero extra surface)
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
    const [tool] = buildSkillTools(skills);
    const result = await tool?.call({ skill: "scorecard-triage" }, {});
    expect(result?.isError).toBe(false);
    expect(result?.content).toContain("# Skill: scorecard-triage");
    expect(result?.content).toContain("1. get_scorecard");
    expect(result?.content).not.toContain("## Skill files"); // body-only skill → no file index
  });

  it("returns an error for an unknown skill name", async () => {
    const [tool] = buildSkillTools(skills);
    const result = await tool?.call({ skill: "nope" }, {});
    expect(result?.isError).toBe(true);
    expect(result?.content).toContain("No such skill");
    expect(result?.content).toContain("scorecard-triage, harness-review");
  });

  it("lists a skill's files (paths + sizes, not contents) in the use_skill payload", async () => {
    const tools = buildSkillTools(withFiles);
    expect(tools.map((t) => t.name)).toEqual([USE_SKILL_TOOL_NAME, READ_SKILL_FILE_TOOL_NAME]);
    const result = await tools[0]?.call({ skill: "fix-pr" }, {});
    expect(result?.isError).toBe(false);
    expect(result?.content).toContain("## Skill files");
    expect(result?.content).toContain("- references/pr-body.md");
    expect(result?.content).not.toContain("What failed"); // file CONTENT stays out until read_skill_file
  });

  it("read_skill_file loads exactly one supporting file on demand", async () => {
    const [, reader] = buildSkillTools(withFiles);
    expect(reader?.isReadOnly).toBe(true);
    expect(reader?.alwaysLoad).toBe(true);
    const result = await reader?.call({ skill: "fix-pr", path: "references/pr-body.md" }, {});
    expect(result?.isError).toBe(false);
    expect(result?.content).toContain("# Skill file: fix-pr/references/pr-body.md");
    expect(result?.content).toContain("What failed");
    expect(result?.content).not.toContain("tests updated"); // the sibling file is not inlined
  });

  it("read_skill_file rejects an unknown path with the available listing", async () => {
    const [, reader] = buildSkillTools(withFiles);
    const result = await reader?.call({ skill: "fix-pr", path: "references/nope.md" }, {});
    expect(result?.isError).toBe(true);
    expect(result?.content).toContain('No such file "references/nope.md"');
    expect(result?.content).toContain("references/pr-body.md, references/checklist.md");
  });

  it("read_skill_file on a file-less skill says the skill has no files", async () => {
    const [, reader] = buildSkillTools(withFiles);
    const result = await reader?.call({ skill: "scorecard-triage", path: "anything.md" }, {});
    expect(result?.isError).toBe(true);
    expect(result?.content).toContain("Available: none");
  });
});

describe("renderSkillListing", () => {
  it("hard-caps each description at 250 chars", () => {
    const listing = renderSkillListing([{ name: "long", description: "x".repeat(400), instructions: "" }, ...skills]);
    const [first] = listing.split("\n");
    expect(first?.length).toBeLessThanOrEqual("- long: ".length + 250);
    expect(first?.endsWith("…")).toBe(true);
  });

  it("shrinks descriptions evenly when the listing exceeds the budget, keeping every skill listed", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      name: `skill-${i}`,
      description: "d".repeat(240),
      instructions: "",
    }));
    const listing = renderSkillListing(many);
    expect(listing.length).toBeLessThanOrEqual(8_000);
    expect(listing.split("\n")).toHaveLength(60); // never drops a skill — only descriptions shrink
  });

  it("degrades to names-only when the per-entry share falls below the minimum", () => {
    const crowd = Array.from({ length: 400 }, (_, i) => ({
      name: `skill-${i}`,
      description: "d".repeat(240),
      instructions: "",
    }));
    const listing = renderSkillListing(crowd);
    expect(listing.split("\n").every((line) => /^- skill-\d+$/.test(line))).toBe(true);
  });
});
