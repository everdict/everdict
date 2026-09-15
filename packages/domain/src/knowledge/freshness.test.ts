import type { SkillRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { anchorRelation, assessCoverage } from "./freshness.js";

const skill: SkillRecord = {
  id: "sk1",
  tenant: "acme",
  name: "scorecard-triage",
  description: "how to triage a regressed scorecard",
  instructions: "…",
  files: [],
  refs: [
    { type: "harness", key: "web-agent", version: "2.1.0" },
    { type: "dataset", key: "login-cases", version: "3.0.0" },
  ],
  visibility: "workspace",
  version: "1.0.0",
  createdBy: "user-alice",
  createdAt: "2026-07-28T00:00:00Z",
  updatedAt: "2026-07-28T01:00:00Z",
};

describe("assessCoverage — record vs the entity's present", () => {
  const now = "2026-07-28T12:00:00Z";
  const latest = (versions: Record<string, string>) => (ref: { type: string; key: string }) =>
    versions[`${ref.type}:${ref.key}`];

  it("is behind when a pin's interval ends before the entity's present (as-of an earlier point, not wrong)", () => {
    const c = assessCoverage(skill, latest({ "harness:web-agent": "2.3.0" }), { now });
    expect(c.state).toBe("behind");
    expect(c.gaps).toEqual([{ ref: skill.refs[0], latest: "2.3.0" }]);
  });

  it("a verify-extended interval covers the present even though the ORIGINAL pin is older", () => {
    const extended = {
      ...skill,
      refs: [{ type: "harness" as const, key: "web-agent", version: "2.1.0", verifiedVersion: "2.3.0" }],
    };
    expect(assessCoverage(extended, latest({ "harness:web-agent": "2.3.0" }), { now }).state).toBe("current");
    // ...and the entity moving on again re-opens the gap from the interval END, not the origin
    const c = assessCoverage(extended, latest({ "harness:web-agent": "2.4.0" }), { now });
    expect(c.state).toBe("behind");
    expect(c.gaps[0]?.latest).toBe("2.4.0");
  });

  it("is current when every pinned interval reaches the latest", () => {
    const c = assessCoverage(skill, latest({ "harness:web-agent": "2.1.0", "dataset:login-cases": "3.0.0" }), {
      now,
    });
    expect(c.state).toBe("current");
  });

  it("falls to unverified after the wall-clock limit, measured from the later of verifiedAt/updatedAt", () => {
    const old = { ...skill, updatedAt: "2026-01-01T00:00:00Z" };
    expect(assessCoverage(old, () => undefined, { now }).state).toBe("unverified");
    const reverified = { ...old, verifiedAt: "2026-07-27T00:00:00Z" };
    expect(assessCoverage(reverified, () => undefined, { now }).state).toBe("current");
  });

  it("ignores unversioned pins and unknown targets (timeless claims and missing signals raise no gap)", () => {
    const unpinned = { ...skill, refs: [{ type: "harness" as const, key: "web-agent" }] };
    expect(assessCoverage(unpinned, latest({ "harness:web-agent": "9.9.9" }), { now }).state).toBe("current");
    expect(assessCoverage(skill, () => undefined, { now }).state).toBe("current");
  });
});

describe("anchorRelation — interval vs an anchor coordinate (the as-of projection kernel)", () => {
  const pin = { type: "harness" as const, key: "web-agent", version: "2.1.0", verifiedVersion: "2.2.0" };

  it("positions the interval [2.1.0, 2.2.0] against anchor coordinates on the boundary table", () => {
    expect(anchorRelation(pin, "2.0.0")).toBe("later"); // knowledge from this coordinate's future
    expect(anchorRelation(pin, "2.1.0")).toBe("covers"); // interval start inclusive
    expect(anchorRelation(pin, "2.2.0")).toBe("covers"); // interval end inclusive
    expect(anchorRelation(pin, "2.3.0")).toBe("earlier"); // as-of an earlier point; validity here unknown
  });

  it("a point pin (no verifiedVersion) covers exactly its own coordinate", () => {
    const point = { type: "harness" as const, key: "web-agent", version: "2.1.0" };
    expect(anchorRelation(point, "2.1.0")).toBe("covers");
    expect(anchorRelation(point, "2.2.0")).toBe("earlier");
  });

  it("an unversioned pin is a timeless family-wide claim; an unresolved anchor is indeterminate", () => {
    expect(anchorRelation({ type: "harness", key: "web-agent" }, "2.1.0")).toBe("general");
    expect(anchorRelation(pin, undefined)).toBeUndefined();
  });
});
