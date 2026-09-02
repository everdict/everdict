import { NotFoundError } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { buildSeedProvenance } from "./seed-provenance.js";

// ── WHAT A CANDIDATE'S SEEDS WERE BORN FROM (harness-identity-and-seeds-spec.md §4) ──────────────────
describe("buildSeedProvenance", () => {
  const seeds = { skills: [{ id: "triage", version: "1.0.0", digest: "d" }], knowledge: [{ id: "k1", digest: "d" }] };
  const reader = buildSeedProvenance({
    harnesses: {
      async get(_t, id, version) {
        if (id === "shop" && version === "1.0.1") return { kind: "command", id, version, command: "x", seeds } as never;
        throw new NotFoundError("NOT_FOUND", { id }, "harness not found");
      },
    },
    skillVersions: {
      async get() {
        return {
          refs: [
            { type: "scorecard", key: "sc-train" },
            { type: "dataset", key: "tb" },
          ],
        } as never;
      },
    },
    knowledgeEntries: {
      async get() {
        return { evidence: [{ type: "scorecard", key: "sc-heldout" }] } as never;
      },
    },
    scorecards: {
      async get(id) {
        if (id === "sc-train")
          return { tenant: "acme", scorecard: { results: [{ caseId: "t1" }, { caseId: "t1" }] } } as never;
        if (id === "sc-heldout") return { tenant: "other", scorecard: { results: [{ caseId: "h1" }] } } as never;
        return undefined;
      },
    },
  });
  it("reads the candidate's seeds, and answers absent for an unregistered version", async () => {
    expect(await reader.seedsOf("acme", { id: "shop", version: "1.0.1" })).toEqual({ kind: "read", value: seeds });
    expect(await reader.seedsOf("acme", { id: "shop", version: "9.9.9" })).toEqual({ kind: "absent" });
  });
  it("names each seed's scorecards with the cases they covered, skipping another workspace's scorecard", async () => {
    expect(await reader.evidenceOf("acme", seeds)).toEqual({
      kind: "read",
      value: [{ seed: "skill:triage@1.0.0", scorecardId: "sc-train", caseIds: ["t1"] }],
    });
  });
  it("a store that throws answers unknown with the reason — never an empty list", async () => {
    const broken = buildSeedProvenance({
      harnesses: {
        async get() {
          throw new Error("registry down");
        },
      },
      skillVersions: {
        async get() {
          throw new Error("db down");
        },
      },
      knowledgeEntries: {
        async get() {
          return undefined;
        },
      },
      scorecards: {
        async get() {
          return undefined;
        },
      },
    });
    expect(await broken.seedsOf("acme", { id: "shop", version: "1" })).toMatchObject({
      kind: "unknown",
      reason: "registry down",
    });
    expect(await broken.evidenceOf("acme", seeds)).toMatchObject({ kind: "unknown", reason: "db down" });
  });
});
