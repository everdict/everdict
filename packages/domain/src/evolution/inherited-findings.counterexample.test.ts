import { describe, expect, it } from "vitest";
import { campaignRoundBrief } from "./round-brief.js";

// ── A CHAINED CAMPAIGN STARTED FROM NOTHING ──────────────────────────────────────────────────────────
//
// `continues` exists so a walk can keep going after an adoption, and `assertChainIsHonest` guards it
// carefully — the predecessor must be settled, its budget spent, its adoption real. Then the successor's
// brief was built from `record.rounds` alone, so everything the predecessor established about the MECHANISM
// was left behind at the campaign boundary. `informedBy` had the same problem from the other side: a round
// names the campaigns whose findings shaped its proposal, and nothing anywhere read that field.
//
// The brief is the artifact a delegate — another agent, a sandbox — is handed. Handing it an empty findings
// list after a five-round predecessor is handing it the search to redo.
//
// The two pointers are DRIVER-DECLARED and the findings are PLATFORM-READ: the loop says which walks are
// relevant, the platform fetches what those walks recorded (rule `protocol` L3). Inherited findings stay
// labelled, because a delegate must be able to tell what this walk established from what it was told.
//
// RED before the change:
//   AssertionError: expected '{ "goal": "Change harness…' to contain 'the tool budget was not'

const frame = {
  subject: { type: "harness" as const, id: "sbench", baselineVersion: "1.0.0" },
  scenarios: [
    { id: "s1", heldOut: false },
    { id: "s2", heldOut: true },
  ],
  targets: ["s1"],
  trialsPerCase: 5,
  judges: [],
  oracleScope: [],
  significance: { fdrAlpha: 0.05, heldOutFamilySize: 5 },
};

describe("a brief carries what earlier WALKS established, not only earlier rounds", () => {
  it("inherited findings reach the delegate, labelled as inherited", () => {
    const brief = campaignRoundBrief({
      campaignId: "camp-2",
      seq: 1,
      frame,
      learned: [],
      inherited: [{ campaignId: "camp-1", findings: ["the tool budget was not the binding constraint"] }],
    });
    const text = JSON.stringify(brief);
    expect(text).toContain("the tool budget was not the binding constraint");
    expect(text).toContain("camp-1");
  });

  it("this walk's own findings stay distinguishable from what it inherited", () => {
    const brief = campaignRoundBrief({
      campaignId: "camp-2",
      seq: 3,
      frame,
      learned: ["the sheet name is what the scaffold was missing"],
      inherited: [{ campaignId: "camp-1", findings: ["the tool budget was not the binding constraint"] }],
    });
    const own = brief.context?.indexOf("the sheet name is what the scaffold was missing") ?? -1;
    const inherited = brief.context?.indexOf("the tool budget was not the binding constraint") ?? -1;
    expect(own).toBeGreaterThanOrEqual(0);
    expect(inherited).toBeGreaterThanOrEqual(0);
    expect(own).not.toBe(inherited);
  });

  it("a campaign that inherited nothing reads exactly as it did before", () => {
    const before = campaignRoundBrief({ campaignId: "camp-1", seq: 1, frame, learned: ["a finding"] });
    const after = campaignRoundBrief({ campaignId: "camp-1", seq: 1, frame, learned: ["a finding"], inherited: [] });
    expect(after).toEqual(before);
  });

  it("THIS WALK'S OWN findings were never redacted either — the free-text channel was the hole", () => {
    // Pre-existing, and widened by inheritance rather than introduced by it. Every STRUCTURED field here
    // excluded the held-out set by construction; `learned` is prose a driver wrote while looking at the
    // whole round, and it reached the delegate verbatim.
    const brief = campaignRoundBrief({
      campaignId: "camp-1",
      seq: 2,
      frame,
      learned: ["s2 fails because the grader cannot read its answer range"],
    });
    expect(JSON.stringify(brief)).not.toContain("s2");
    expect(JSON.stringify(brief)).toContain("held-out");
  });

  it("a case id that is a SUBSTRING of another token is not redacted", () => {
    // Ids are short (`s2`, `15380`), so substring matching would eat the middle of ordinary words and of
    // LONGER IDS — `s21` is a different case and redacting half of it would be worse than not redacting.
    // Quotes and brackets are NOT word characters and DO precede a real reference (`case 's2' fails`), so
    // they are deliberately still a boundary.
    const brief = campaignRoundBrief({
      campaignId: "camp-1",
      seq: 2,
      frame,
      learned: ["s21 and als2mple were unaffected"],
    });
    expect(brief.context).toContain("s21 and als2mple");
  });

  it("EXCLUSIONS SURVIVE INHERITANCE: a held-out id in an inherited finding is still not briefable", () => {
    // The predecessor's `learned` is driver-authored prose and the driver of THAT campaign could have
    // written a held-out scenario's name into it. The oracle rule is about what reaches the subject, and
    // inheritance is a new path to the same place.
    const brief = campaignRoundBrief({
      campaignId: "camp-2",
      seq: 1,
      frame,
      learned: [],
      inherited: [{ campaignId: "camp-1", findings: ["case s2 fails because the grader cannot read its range"] }],
    });
    expect(JSON.stringify(brief)).not.toContain("s2");
  });
});
