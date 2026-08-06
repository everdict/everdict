import type { DelegationBrief } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { renderDelegationBrief } from "./render-brief.js";

const base: DelegationBrief = { goal: "make the regressed cases pass", references: [], constraints: [], doneWhen: [] };

describe("renderDelegationBrief — the handoff the delegate actually reads", () => {
  it("always states the goal, and omits every section the brief did not fill", () => {
    const rendered = renderDelegationBrief(base);
    expect(rendered).toContain("## Goal");
    expect(rendered).toContain("make the regressed cases pass");
    // Hide-empty: an empty section would tell the delegate to look for something that was never handed over.
    expect(rendered).not.toContain("## Context");
    expect(rendered).not.toContain("## References");
    expect(rendered).not.toContain("## Constraints");
    expect(rendered).not.toContain("## Done when");
  });

  it("renders references with their kind, id, version and the reason each was handed over", () => {
    const rendered = renderDelegationBrief({
      ...base,
      references: [
        { type: "scorecard", id: "sc-9", note: "the batch that regressed" },
        { type: "harness", id: "aider", version: "1.2.0" },
      ],
    });
    expect(rendered).toContain("- scorecard `sc-9` — the batch that regressed");
    expect(rendered).toContain("- harness `aider@1.2.0`");
  });

  it("renders constraints and done-criteria as lists the delegate can check itself against", () => {
    const rendered = renderDelegationBrief({
      ...base,
      context: "  two cases started failing after the judge changed  ",
      constraints: ["do not touch the dataset"],
      doneWhen: ["the two cases pass", "no other case regresses"],
    });
    expect(rendered).toContain("## Context\ntwo cases started failing after the judge changed"); // trimmed
    expect(rendered).toContain("- do not touch the dataset");
    expect(rendered).toContain("- the two cases pass");
    expect(rendered).toContain("- no other case regresses");
  });
});
