import { CapabilityRecordSchema, FIRST_PARTY_TENANT } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { WEBSEARCH_SECRET_NAME, firstPartyDefaults } from "./first-party.js";

describe("firstPartyDefaults", () => {
  const defaults = firstPartyDefaults();

  it("every seed is a valid, first-party, public CapabilityRecord", () => {
    expect(defaults.length).toBeGreaterThan(0);
    for (const d of defaults) {
      const parsed = CapabilityRecordSchema.parse(d.record); // throws on any drift from the contract
      expect(parsed.tenant).toBe(FIRST_PARTY_TENANT);
      expect(parsed.visibility).toBe("public"); // browsable/adoptable in the store too
    }
  });

  it("ships a web-search code tool that declares the search-key secret", () => {
    const web = defaults.find((d) => d.record.id === "web-search");
    expect(web).toBeDefined();
    if (!web) return;
    expect(web.requires).toBeNull(); // unconditional (not integration-gated)
    expect(web.record.spec.type).toBe("code");
    if (web.record.spec.type !== "code") return;
    expect(web.record.spec.requiredSecrets.map((s) => s.name)).toContain(WEBSEARCH_SECRET_NAME);
    expect(web.record.spec.isReadOnly).toBe(true);
  });

  it("ships the scorecard-fix-PR skill, gated on the GitHub integration (the first skill-kind default)", () => {
    const skill = defaults.find((d) => d.record.id === "scorecard-fix-pr");
    expect(skill).toBeDefined();
    if (!skill) return;
    expect(skill.requires).toBe("github"); // reads the repo + opens the PR via the workspace GitHub App
    expect(skill.record.spec.type).toBe("skill");
    if (skill.record.spec.type !== "skill") return;
    // The procedure's load-bearing steps: diagnose from scorecard evidence, fix via a PR, and carry the experiment
    // context in the PR body (the whole point of the skill — a reviewer judges the fix without re-running).
    for (const anchor of ["get_scorecard", "get_github_file", "open_github_pr", "Root cause", "Failing cases"]) {
      expect(skill.record.spec.instructions).toContain(anchor);
    }
  });

  it("ships a pdf-read code tool that needs no secret and is HITL-gated (arbitrary-URL fetch)", () => {
    const pdf = defaults.find((d) => d.record.id === "pdf-read");
    expect(pdf).toBeDefined();
    if (!pdf) return;
    expect(pdf.requires).toBeNull(); // unconditional
    expect(pdf.record.spec.type).toBe("code");
    if (pdf.record.spec.type !== "code") return;
    expect(pdf.record.spec.requiredSecrets).toEqual([]); // no key → always offered
    expect(pdf.record.spec.isReadOnly).toBe(false); // arbitrary URL fetch → HITL-gated
  });
});
