import { describe, expect, it } from "vitest";
import { DatasetSchema } from "./execution/dataset.js";
import { VersionSchema } from "./version.js";

describe("VersionSchema — a non-empty version is a contract invariant", () => {
  it("rejects an empty string and accepts a real version", () => {
    expect(VersionSchema.safeParse("").success).toBe(false);
    expect(VersionSchema.safeParse("1.0.0").success).toBe(true);
    expect(VersionSchema.safeParse("v1").success).toBe(true); // free-string versions stay allowed
  });

  // Regression: a bare z.string() let "" through, and compareVersions treats it as equal-to-everything, so an empty
  // version sorted to the tail and became `latest`. A spec schema now rejects it — with an otherwise-valid dataset,
  // version is the sole discriminator between reject and accept.
  it("a spec schema rejects an empty version but accepts a real one", () => {
    const base = {
      id: "d",
      tags: [],
      cases: [{ id: "c1", env: { kind: "repo", source: { files: {} } }, task: "t", graders: [{ id: "steps" }] }],
    };
    expect(DatasetSchema.safeParse({ ...base, version: "" }).success).toBe(false);
    expect(DatasetSchema.safeParse({ ...base, version: "1.0.0" }).success).toBe(true);
  });
});
