import { describe, expect, it } from "vitest";
import { type IssueDelegationBriefInput, issueDelegationBrief } from "./issue-brief.js";

const input = (over: Partial<IssueDelegationBriefInput> = {}): IssueDelegationBriefInput => ({
  issue: {
    identifier: "DIGO-6",
    title: "trips imported from Triple are not visible in the app",
    description: "A user asked where their imported trip went.",
    status: "backlog",
  },
  commits: [],
  related: [],
  knowledge: [],
  ...over,
});

describe("an issue's brief is derived from the record, not re-typed from it", () => {
  it("names the issue and points the delegate at its own description", () => {
    const brief = issueDelegationBrief(input());
    expect(brief.goal).toContain("DIGO-6");
    expect(brief.context).toContain("A user asked where their imported trip went.");
    expect(brief.references).toContainEqual(expect.objectContaining({ type: "issue", id: "DIGO-6" }));
  });

  // ⚠️ THE EXCLUSION THIS FILE EXISTS FOR. A related issue's RESOLUTION reads as "here is the answer", and a
  // delegate handed a previous fix applies that fix — which is how one misdiagnosis becomes two. The campaign
  // brief refuses scores for the same reason one lane over: a delegate that can see the answer aims at it.
  it("names a related issue and never says how it was resolved", () => {
    const brief = issueDelegationBrief(
      input({
        related: [{ identifier: "DIGO-2", title: "dead controls", status: "done" }],
      }),
    );
    expect(brief.context).toContain("DIGO-2 (done) — dead controls");
    expect(brief.context).toContain("deliberately not here");
    expect(brief.context).not.toMatch(/resolution|resolved by|the fix was/i);
  });

  it("hands over what the workspace already learned, as references it can look up", () => {
    const brief = issueDelegationBrief(
      input({ knowledge: [{ id: "k1", title: "the sheet swallows wheel scroll", kind: "finding" }] }),
    );
    expect(brief.context).toContain("[finding] the sheet swallows wheel scroll");
    expect(brief.references).toContainEqual(expect.objectContaining({ type: "knowledge", id: "k1" }));
  });

  it("warns that someone has already been here when commits are linked", () => {
    const brief = issueDelegationBrief(
      input({ commits: [{ repository: "PPP-Atelier/digo-mobile", sha: "e4fe66e8bfcb", note: "profile sheet" }] }),
    );
    expect(brief.context).toContain("`e4fe66e` in PPP-Atelier/digo-mobile — profile sheet");
    expect(brief.context).toContain("misdiagnosed");
  });

  // An empty section that says "there is nothing here" trains the reader to skip sections.
  // ⚠️ THE THIRD VALUE. "Nobody has learned anything" and "the store could not be read" are the same empty
  // array, and they tell a delegate opposite things: the first says go ahead, the second says you may be
  // about to repeat work somebody already did. A brief that rendered them alike would be confidently wrong.
  it("says the knowledge was UNAVAILABLE rather than letting it read as none", () => {
    const brief = issueDelegationBrief(input({ knowledge: [], knowledgeUnavailable: "knowledge store timed out" }));
    expect(brief.context).toContain("UNAVAILABLE");
    expect(brief.context).toContain("knowledge store timed out");
    expect(brief.context).toContain("not the");
    expect(brief.context).toContain("same as there being none");
  });

  it("omits a section it has nothing to put in", () => {
    const brief = issueDelegationBrief(input());
    expect(brief.context).not.toContain("## Related issues");
    expect(brief.context).not.toContain("## Commits already linked");
  });
});

describe("the finish line is answerable and does not reward a confident wrong fix", () => {
  it("gives every criterion a semantic id", () => {
    expect(issueDelegationBrief(input()).doneWhen.map((c) => c.id)).toEqual([
      "issue-symptom-gone",
      "repo-gates-pass",
      "change-is-scoped",
      "report-filed",
    ]);
  });

  // "I could not reproduce it" is the answer most likely to be dressed up as success, because nothing
  // visibly fails. Naming it in the criterion is what makes the honest answer the easy one.
  it("says that failing to reproduce is not a pass", () => {
    const symptom = issueDelegationBrief(input()).doneWhen[0];
    expect(symptom?.statement).toMatch(/could not reproduce/);
    expect(symptom?.statement).toMatch(/needs_information/);
  });

  it("asks for a pre-existing failure's baseline rather than letting it be hidden", () => {
    expect(issueDelegationBrief(input()).doneWhen[1]?.statement).toMatch(/baseline, not hidden/);
  });

  it("keeps the verdict with the orchestrator", () => {
    expect(issueDelegationBrief(input()).constraints.join("\n")).toMatch(/grading its own exam/);
  });

  it("carries the supervisor's own checks as criteria the delegate can answer", () => {
    const brief = issueDelegationBrief(input({ extraChecks: ["the import row shows day_count > 0"] }));
    expect(brief.doneWhen.at(-1)).toEqual({
      id: "supervisor-1",
      statement: "the import row shows day_count > 0",
    });
  });
});
