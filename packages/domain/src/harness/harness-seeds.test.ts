import { describe, expect, it } from "vitest";
import { knowledgeSeedDigest, knowledgeSeedFile, skillSeedDigest, skillSeedFiles } from "./harness-seeds.js";

describe("harness seeds — the bytes a seed names, and where they land", () => {
  const version = {
    instructions: "# Triage\n…",
    files: [
      { path: "b.md", content: "B" },
      { path: "a.md", content: "A" },
    ],
  };
  it("a skill seed's digest covers instructions and files, independent of file order", () => {
    const reordered = { ...version, files: [...version.files].reverse() };
    expect(skillSeedDigest(version)).toBe(skillSeedDigest(reordered));
    expect(skillSeedDigest({ ...version, instructions: "changed" })).not.toBe(skillSeedDigest(version));
    expect(skillSeedDigest(version)).toMatch(/^sha256:/);
  });
  it("a knowledge seed's digest covers title and body", () => {
    expect(knowledgeSeedDigest({ title: "t", body: "b" })).not.toBe(knowledgeSeedDigest({ title: "t", body: "c" }));
  });
  it("seeds land under the fixed mount, SKILL.md plus its files, one markdown per knowledge entry", () => {
    expect(skillSeedFiles("triage", version).map((f) => f.path)).toEqual([
      "/everdict/seeds/skills/triage/SKILL.md",
      "/everdict/seeds/skills/triage/files/b.md",
      "/everdict/seeds/skills/triage/files/a.md",
    ]);
    expect(knowledgeSeedFile("k1", { title: "Retry budget", body: "three" })).toEqual({
      path: "/everdict/seeds/knowledge/k1.md",
      content: "# Retry budget\n\nthree",
    });
  });
});
