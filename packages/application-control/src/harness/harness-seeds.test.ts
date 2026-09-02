import { knowledgeSeedDigest, skillSeedDigest } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import { type SeedReader, materializeSeeds } from "./harness-seeds.js";

// ── A SEED IS THE BYTES IT NAMED, OR THE RUN IS REFUSED (harness-identity-and-seeds-spec.md §2) ───────
describe("materializeSeeds", () => {
  const skill = {
    instructions: "# Triage",
    files: [{ path: "a.md", content: "A" }],
    visibility: "workspace" as const,
    createdBy: "alice",
  };
  const entry = { title: "Retry budget", body: "three", visibility: "workspace" as const, createdBy: "alice" };
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
      "bob",
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
        "bob",
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      materializeSeeds(
        "acme",
        { skills: [{ id: "triage", version: "9.9.9", digest: skillSeedDigest(skill) }], knowledge: [] },
        reader,
        "bob",
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      materializeSeeds("acme", { skills: [], knowledge: [{ id: "k1", digest: "sha256:stale" }] }, reader, "bob"),
    ).rejects.toMatchObject({ status: 409 });
  });
});

// ── A PRIVATE SEED BELONGS TO ITS AUTHOR (code-review pass 1) ─────────────────────────────────────────
//
// RED before the check: any member who knew a private skill's id, version and digest could seed it into a
// harness they run and read its bytes out of the sandbox.
describe("materializeSeeds — a private skill or entry is held for its author's run only", () => {
  const skill = { instructions: "# Triage", files: [], visibility: "private" as const, createdBy: "alice" };
  const entry = { title: "Retry budget", body: "three", visibility: "private" as const, createdBy: "alice" };
  const privateReader: SeedReader = {
    async skillVersion() {
      return skill;
    },
    async knowledgeEntry() {
      return entry;
    },
  };
  it("the author's run carries it; another submitter, or no submitter, reads 404 — never 403", async () => {
    const seeds = { skills: [{ id: "triage", version: "1.2.0", digest: skillSeedDigest(skill) }], knowledge: [] };
    await expect(materializeSeeds("acme", seeds, privateReader, "alice")).resolves.toHaveLength(1);
    await expect(materializeSeeds("acme", seeds, privateReader, "bob")).rejects.toMatchObject({ status: 404 });
    await expect(materializeSeeds("acme", seeds, privateReader, undefined)).rejects.toMatchObject({ status: 404 });
    const knowledge = { skills: [], knowledge: [{ id: "k1", digest: knowledgeSeedDigest(entry) }] };
    await expect(materializeSeeds("acme", knowledge, privateReader, "alice")).resolves.toHaveLength(1);
    await expect(materializeSeeds("acme", knowledge, privateReader, "bob")).rejects.toMatchObject({ status: 404 });
  });
});
