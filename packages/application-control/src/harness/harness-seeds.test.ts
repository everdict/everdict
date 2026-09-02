import { knowledgeSeedDigest, skillSeedDigest } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import { type SeedReader, materializeSeeds } from "./harness-seeds.js";

// ── A SEED IS THE BYTES IT NAMED, OR THE RUN IS REFUSED (harness-identity-and-seeds-spec.md §2) ───────
describe("materializeSeeds", () => {
  const skill = { instructions: "# Triage", files: [{ path: "a.md", content: "A" }] };
  const entry = { title: "Retry budget", body: "three" };
  const reader: SeedReader = {
    async skillVersion(_t, id, version) {
      return id === "triage" && version === "1.2.0" ? skill : undefined;
    },
    async knowledgeEntry(_t, id) {
      return id === "k1" ? entry : undefined;
    },
  };
  it("writes the named bytes at the mount when every digest holds", async () => {
    const files = await materializeSeeds(
      "acme",
      {
        skills: [{ id: "triage", version: "1.2.0", digest: skillSeedDigest(skill) }],
        knowledge: [{ id: "k1", digest: knowledgeSeedDigest(entry) }],
      },
      reader,
    );
    expect(files.map((f) => f.path)).toEqual([
      "/everdict/seeds/skills/triage/SKILL.md",
      "/everdict/seeds/skills/triage/files/a.md",
      "/everdict/seeds/knowledge/k1.md",
    ]);
  });
  it("refuses a seed whose bytes moved (409) and one the workspace does not hold (404)", async () => {
    await expect(
      materializeSeeds(
        "acme",
        { skills: [{ id: "triage", version: "1.2.0", digest: "sha256:stale" }], knowledge: [] },
        reader,
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      materializeSeeds(
        "acme",
        { skills: [{ id: "triage", version: "9.9.9", digest: skillSeedDigest(skill) }], knowledge: [] },
        reader,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      materializeSeeds("acme", { skills: [], knowledge: [{ id: "k1", digest: "sha256:stale" }] }, reader),
    ).rejects.toMatchObject({ status: 409 });
  });
});
