import { describe, expect, it } from "vitest";
import {
  type MemberSelectionCandidate,
  authoredSkillKey,
  builtinToolKey,
  capabilityToolKey,
  mcpServerToolKey,
  selectForMember,
} from "./member-selection.js";

const adopted: MemberSelectionCandidate = { key: capabilityToolKey("acme", "jira"), name: "jira", baseline: true };
const authored: MemberSelectionCandidate = {
  key: capabilityToolKey("acme", "draft"),
  name: "draft_tool",
  baseline: false,
};
const mine: MemberSelectionCandidate = { key: capabilityToolKey("acme", "scratch"), name: "scratch", baseline: false };
const builtin: MemberSelectionCandidate = { key: builtinToolKey("web-search"), name: "web_search", baseline: true };

const enabledKeys = (selections: ReturnType<typeof selectForMember>): string[] =>
  selections.filter((s) => s.enabled).map((s) => s.candidate.key);

describe("agent preference keys", () => {
  it("namespaces each channel so ids from different spaces cannot collide", () => {
    expect(builtinToolKey("web-search")).toBe("default:web-search");
    expect(capabilityToolKey("acme", "jira")).toBe("capability:acme/jira");
    expect(mcpServerToolKey("internal")).toBe("mcp:internal");
    expect(authoredSkillKey("triage")).toBe("skill:triage");
  });
});

describe("selectForMember", () => {
  it("follows the workspace baseline for a member who configured nothing", () => {
    const selected = selectForMember([adopted, authored, mine, builtin], {});
    expect(enabledKeys(selected)).toEqual([adopted.key, builtin.key]);
  });

  it("lets a member turn OFF a tool the workspace turned on — for themselves only", () => {
    const selected = selectForMember([adopted, builtin], { [adopted.key]: false });
    expect(enabledKeys(selected)).toEqual([builtin.key]);
  });

  it("lets a member turn ON an available tool the workspace did not adopt", () => {
    const selected = selectForMember([authored, mine], { [mine.key]: true });
    expect(enabledKeys(selected)).toEqual([mine.key]);
  });

  it("gives two members of the same workspace two different toolsets", () => {
    const candidates = [adopted, mine, builtin];
    expect(enabledKeys(selectForMember(candidates, { [mine.key]: true }))).toEqual([
      adopted.key,
      mine.key,
      builtin.key,
    ]);
    expect(enabledKeys(selectForMember(candidates, { [adopted.key]: false, [builtin.key]: false }))).toEqual([]);
  });

  it("keeps following the workspace when an override is removed (absent key ≠ false)", () => {
    const selected = selectForMember([adopted], {});
    expect(selected[0]?.enabled).toBe(true);
    expect(selected[0]?.candidate.baseline).toBe(true);
  });

  it("shadows a later same-named tool and reports which key won", () => {
    const shadowing: MemberSelectionCandidate = {
      key: capabilityToolKey("acme", "search"),
      name: "web_search",
      baseline: true,
    };
    const selected = selectForMember([shadowing, builtin], {});
    expect(enabledKeys(selected)).toEqual([shadowing.key]);
    expect(selected[1]?.shadowedBy).toBe(shadowing.key);
  });

  it("does not let a DISABLED tool shadow a name", () => {
    const shadowing: MemberSelectionCandidate = {
      key: capabilityToolKey("acme", "search"),
      name: "web_search",
      baseline: true,
    };
    const selected = selectForMember([shadowing, builtin], { [shadowing.key]: false });
    expect(enabledKeys(selected)).toEqual([builtin.key]);
    expect(selected[1]?.shadowedBy).toBeUndefined();
  });

  it("preserves input order deterministically", () => {
    const selected = selectForMember([builtin, adopted], {});
    expect(selected.map((s) => s.candidate.key)).toEqual([builtin.key, adopted.key]);
  });
  // The skills channel rides the same kernel: an authored skill outranks a same-named package, exactly as the agent
  // has always resolved its use_skill library.
  it("lets an authored skill shadow a same-named package", () => {
    const authoredSkill: MemberSelectionCandidate = { key: authoredSkillKey("triage"), name: "triage", baseline: true };
    const packagedSkill: MemberSelectionCandidate = {
      key: capabilityToolKey("acme", "triage-pkg"),
      name: "triage",
      baseline: true,
    };
    const selected = selectForMember([authoredSkill, packagedSkill], {});
    expect(enabledKeys(selected)).toEqual([authoredSkill.key]);
    expect(selected[1]?.shadowedBy).toBe(authoredSkill.key);
  });

  it("promotes the package once the member switches the authored skill off", () => {
    const authoredSkill: MemberSelectionCandidate = { key: authoredSkillKey("triage"), name: "triage", baseline: true };
    const packagedSkill: MemberSelectionCandidate = {
      key: capabilityToolKey("acme", "triage-pkg"),
      name: "triage",
      baseline: true,
    };
    const selected = selectForMember([authoredSkill, packagedSkill], { [authoredSkill.key]: false });
    expect(enabledKeys(selected)).toEqual([packagedSkill.key]);
  });
});
