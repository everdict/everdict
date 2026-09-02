import type { CampaignBuildRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryCampaignBuildStore } from "./campaign-build-store.js";

// The campaign build ledger (docs/architecture/code-evolution-loop.md, D2). The settle writes are CONDITIONAL
// on `building`, so a build that raced its own retry, or was already settled, is not recorded twice — the
// in-memory twin makes the SAME decisions the Pg statement does (rule `testing`).
const building = (over: Partial<CampaignBuildRecord> = {}): CampaignBuildRecord => ({
  id: "bld_1",
  tenant: "acme",
  campaignId: "evc_1",
  slot: "image",
  source: { git: "https://github.com/acme/scaffold.git", repo: "acme/scaffold", ref: "abc123", prNumber: 7 },
  base: { version: "1.0.0", image: "reg/scaffold:1.0.0" },
  state: "building",
  createdBy: "alice",
  createdAt: "2026-09-02T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
  ...over,
});

const RESULT = {
  sha: "abc123def",
  image: {
    repository: "acme-scaffold-image",
    tag: "sha-abc123def",
    ref: "reg/ns/acme-scaffold-image:sha-abc123def@sha256:beef",
    digest: "sha256:beef",
  },
  candidateVersion: "1.0.1",
  receipt: {
    steps: ["make"],
    stepsDigest: "sha256:steps",
    workDir: "/everdict/build",
    capture: ["/everdict/build"],
    startedAt: "t0",
    finishedAt: "t1",
  },
  at: "2026-09-02T01:00:00.000Z",
};

describe("InMemoryCampaignBuildStore — the settle is conditional on building", () => {
  it("completes a building record once, writing the observed sha, image, version and receipt", async () => {
    const store = new InMemoryCampaignBuildStore();
    await store.create(building());
    expect(await store.complete("acme", "bld_1", RESULT)).toBe("completed");
    const read = await store.get("acme", "bld_1");
    expect(read?.state).toBe("built");
    expect(read?.source.sha).toBe("abc123def");
    expect(read?.image?.digest).toBe("sha256:beef");
    expect(read?.candidateVersion).toBe("1.0.1");
    // A second settle finds it no longer building — success is not recorded twice.
    expect(await store.complete("acme", "bld_1", RESULT)).toBe("not_building");
    expect(await store.fail("acme", "bld_1", { error: "late", at: "t2" })).toBe("not_building");
  });

  it("fails a building record with a reason, and only a building one", async () => {
    const store = new InMemoryCampaignBuildStore();
    await store.create(building({ id: "bld_2" }));
    expect(await store.fail("acme", "bld_2", { error: "make: *** [all] Error 2", sha: "abc123def", at: "t2" })).toBe(
      "failed",
    );
    const read = await store.get("acme", "bld_2");
    expect(read?.state).toBe("failed");
    expect(read?.error).toMatch(/Error 2/);
    expect(read?.source.sha).toBe("abc123def");
    expect(await store.complete("acme", "bld_2", RESULT)).toBe("not_building");
  });

  it("answers another workspace, and an unknown build, as absent", async () => {
    const store = new InMemoryCampaignBuildStore();
    await store.create(building());
    expect(await store.get("other", "bld_1")).toBeUndefined();
    expect(await store.complete("other", "bld_1", RESULT)).toBe("absent");
    expect(await store.fail("acme", "bld_ghost", { error: "x", at: "t" })).toBe("absent");
  });

  it("lists a campaign's builds newest first", async () => {
    const store = new InMemoryCampaignBuildStore();
    await store.create(building({ id: "bld_a", createdAt: "2026-09-02T00:00:00.000Z" }));
    await store.create(building({ id: "bld_b", createdAt: "2026-09-02T02:00:00.000Z" }));
    await store.create(building({ id: "bld_other", campaignId: "evc_2" }));
    expect((await store.forCampaign("acme", "evc_1")).map((b) => b.id)).toEqual(["bld_b", "bld_a"]);
  });
});
