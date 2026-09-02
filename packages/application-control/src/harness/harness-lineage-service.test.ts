import type { CapabilityOrigin, EvolutionCampaignRecord, HarnessSpec } from "@everdict/contracts";
import { contentDigest } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import { type HarnessLineageDeps, harnessLineage, slotOfPath } from "./harness-lineage-service.js";

// ── LINEAGE IS ONE READ (harness-identity-and-seeds-spec.md §3) ───────────────────────────────────────
const spec = (version: string, image: string, seeds?: HarnessSpec["seeds"]): HarnessSpec =>
  ({
    kind: "service",
    id: "shop",
    version,
    services: [{ name: "web", image, needs: [], perRun: [], replicas: 1, env: {} }],
    dependencies: [],
    frontDoor: { service: "web", submit: "POST /runs" },
    ...(seeds !== undefined ? { seeds } : {}),
  }) as unknown as HarnessSpec;

describe("harnessLineage", () => {
  const v1 = spec("1.0.0", "img@sha256:aaa");
  const v2 = spec("1.0.1", "img@sha256:bbb", { skills: [{ id: "triage", version: "1", digest: "d" }], knowledge: [] });
  const v3 = spec("1.0.2", "img@sha256:bbb");
  const origins: Record<string, CapabilityOrigin> = {
    "1.0.1": { via: "ci", from: { type: "harness", id: "shop", version: "1.0.0" }, note: "re-pin: web" },
    "1.0.2": {
      via: "web",
      from: { type: "issue", id: "iss_1" },
      forkedFrom: { id: "other", version: "2.0.0", specDigest: "sha256:other" },
    },
  };
  const instances = {
    async versions() {
      return ["1.0.0", "1.0.1", "1.0.2"];
    },
    async get(_t: string, _id: string, ref?: string) {
      return ({ "1.0.0": v1, "1.0.1": v2, "1.0.2": v3 } as Record<string, HarnessSpec>)[ref ?? ""] as HarnessSpec;
    },
    async list() {
      return [
        {
          id: "shop",
          latestVersion: "1.0.2",
          versionCount: 3,
          versionOrigins: origins,
          versionTags: { "1.0.1": ["baseline"] },
        },
      ];
    },
  } as unknown as HarnessLineageDeps["instances"]; // the list entry's display fields are not what this read consumes
  it("composes, per version: digest, origin, predecessor (origin or order), fork, intent, seeds, the diff with its slots, adoptions", async () => {
    const adopted = {
      id: "evc_1",
      issueId: "iss_1",
      close: { outcome: { kind: "adopted", version: "1.0.1", provingScorecardId: "sc-9" } },
    } as unknown as EvolutionCampaignRecord;
    const lineage = await harnessLineage(
      { instances, campaigns: { forSubject: async () => [adopted] } },
      "acme",
      "shop",
    );
    expect(lineage.adoptionsKnown).toBe(true);
    const [a, b, c] = lineage.versions;
    expect(a).toMatchObject({ version: "1.0.0", specDigest: contentDigest(v1), tags: [] });
    expect(a?.predecessor).toBeUndefined();
    expect(b).toMatchObject({
      version: "1.0.1",
      predecessor: { version: "1.0.0", via: "origin" },
      tags: ["baseline"],
      seeds: v2.seeds,
      adoptedBy: [{ campaignId: "evc_1", issueId: "iss_1", provingScorecardId: "sc-9" }],
    });
    expect(b?.diff?.slots).toEqual(["seeds", "web"]);
    expect(b?.bornFrom).toBeUndefined(); // a same-family origin is the predecessor, not an intent
    expect(c).toMatchObject({
      version: "1.0.2",
      predecessor: { version: "1.0.1", via: "order" },
      forkedFrom: { id: "other", version: "2.0.0", specDigest: "sha256:other" },
      bornFrom: { type: "issue", id: "iss_1" },
    });
    expect(c?.diff?.slots).toEqual(["seeds"]); // seeds removed against 1.0.1
  });
  it("with no campaign reader, adoptions are not asked — and the answer says so rather than reading empty", async () => {
    const lineage = await harnessLineage({ instances }, "acme", "shop");
    expect(lineage.adoptionsKnown).toBe(false);
    expect(lineage.versions.every((v) => v.adoptedBy === undefined)).toBe(true);
  });
  it("slotOfPath names the service a path belongs to, else the top-level key", () => {
    expect(slotOfPath("services[web].image")).toBe("web");
    expect(slotOfPath("seeds.skills[0].version")).toBe("seeds");
    expect(slotOfPath("command")).toBe("command");
  });
});
