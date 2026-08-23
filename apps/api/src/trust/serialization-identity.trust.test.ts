import { storedExecutionId } from "@everdict/contracts";
import type { ScorecardRecord, ScoringPass } from "@everdict/contracts";
import { PgScorecardStore } from "@everdict/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRUST_PG_ENABLED, type TrustPg, openTrustPg, trustId } from "./trust-context.js";

// Trust suite (docs/trust-certification.md) — TRUST-104 · TRUST-105.
//
// A SEMANTIC CAPABILITY MUST SURVIVE SERIALIZATION UNCHANGED.
//
// These are SERIALIZATION-level scenarios, and the distinction is the point. A decision test proves a function
// means the right thing; this proves the meaning still exists after the database. Two features shipped in the
// last two waves were correct in memory and gone in production — the pass's nested pins (a schema that never
// learned the new fields, so `parse()` dropped them on reload) and the world cohort (a column that was never
// added). Both had green tests. Neither test crossed this boundary.
describe.skipIf(!TRUST_PG_ENABLED)("TRUST-104/105 — identity survives the database (real Postgres)", () => {
  let pg: TrustPg;
  let cards: PgScorecardStore;

  beforeAll(async () => {
    pg = await openTrustPg();
    cards = new PgScorecardStore(pg.client);
  });
  afterAll(async () => pg?.close());

  const sealedJudges: ScoringPass["judges"] = [
    {
      id: "quality",
      version: "1.0.0",
      specDigest: "sha256:doc",
      model: "model-x@1.0.0",
      modelDigest: "sha256:model",
      rubric: "style@2.0.0",
      rubricDigest: "sha256:rubric",
      harness: "grader-agent@4.0.0",
      harnessDigest: "sha256:agent",
    },
  ];

  async function seed(): Promise<string> {
    const id = trustId("sc-serde");
    await cards.create({
      id,
      tenant: "trust",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      status: "succeeded",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as ScorecardRecord);
    return id;
  }

  it("TRUST-104 — a pass's NESTED document pins are still there after a round trip", async () => {
    // The pass is the authority token an activity carries. Its closure had its own literal schema, so when the
    // closure grew document digests only the manifest and the revision learned them — and the reload silently
    // returned a pass whose nested verification had nothing to verify against.
    const id = await seed();
    await cards.update(
      id,
      {
        scoringPass: {
          passId: "pass-A",
          epoch: 1,
          leaseUntil: "2999-01-01T00:00:00.000Z",
          heartbeatAt: "2026-01-01T00:00:00.000Z",
          targetRevision: 1,
          baseRevision: 0,
          judges: sealedJudges,
          startedAt: "2026-01-01T00:00:00.000Z",
          status: "running",
        },
      },
      undefined,
      { expectScoringPassId: null },
    );
    // Read back through the production mapper, which is where `parse()` drops what a schema does not name.
    expect((await cards.get(id))?.scoringPass?.judges).toEqual(sealedJudges);
  });

  it("…and the manifest's copy of the same closure round-trips identically — one shape, one meaning", async () => {
    const id = await seed();
    await cards.update(id, {
      manifest: {
        identityVersion: 1,
        dataset: { id: "d", version: "1.0.0", digest: "sha256:ds" },
        harness: { id: "h", version: "1", specDigest: "sha256:hs", modelDigest: "sha256:hm" },
        judges: sealedJudges,
      } as ScorecardRecord["manifest"],
    });
    const back = await cards.get(id);
    expect(back?.manifest?.judges).toEqual(sealedJudges);
    expect(back?.manifest?.harness.modelDigest).toBe("sha256:hm");
  });

  it("TRUST-105 — the execution WORLD is stored, and readable through list() where readiness reads it", async () => {
    // Product readiness reads scorecards through `list`, so a world that only survived on `get` would be
    // invisible exactly where it is consumed. The first version of this feature had no column at all.
    const id = await seed();
    const world = { os: "linux" as const, drivers: ["docker"], mixed: false, observed: 3 };
    await cards.update(id, { world });
    expect((await cards.get(id))?.world).toEqual(world);
    const listed = (await cards.list(storedExecutionId("trust"))).find((r) => r.id === id);
    expect(listed?.world).toEqual(world);
  });
});
