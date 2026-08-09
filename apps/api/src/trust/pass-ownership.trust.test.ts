import type { RunRecord, ScorecardRecord, ScoringPass } from "@everdict/contracts";
import { PgRunStore, PgScorecardStore } from "@everdict/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRUST_PG_ENABLED, type TrustPg, openTrustPg, trustId } from "./trust-context.js";

// Trust suite (docs/trust-certification.md) — TRUST-42.
//
// AT MOST ONE PASS OWNS THE RIGHT TO MUTATE A SCORE PLANE, AND A SUPERSEDED PASS CAN NEVER WRITE AGAIN.
// The previous generation made a scoring pass VISIBLE (readers refuse a plane between revisions); visibility
// is not ownership, and the gap between them is where the plane and the revision certifying it come apart.
//
// Only a REAL Postgres can certify this. The claim is a jsonb compare-and-swap and the child-write fence is a
// cross-row EXISTS condition inside the write statement — an in-memory fake serializes by construction and
// proves nothing about either. Certified here:
//   (1) two claimants racing on an empty marker → exactly one wins, decided by the CAS not by write order;
//   (2) a takeover, after which the old owner can no longer renew or settle;
//   (3) a superseded pass's child write refused — INCLUDING after the winner settled and cleared the marker,
//       the interleaving the read guard structurally cannot see (nothing is left but the fence);
//   (4) the ABA: a settle clears the marker so the epoch counter restarts, and a stale writer holding the
//       reused number must still be refused — which is why the fence is the passId, never the epoch. This
//       one matters most for EMBED groups: they have no child rows, so the settle guard is the only fence.
describe.skipIf(!TRUST_PG_ENABLED)("TRUST-42 — a scoring pass owns the plane (real Postgres)", () => {
  let pg: TrustPg;
  let cards: PgScorecardStore;
  let runs: PgRunStore;

  beforeAll(async () => {
    pg = await openTrustPg();
    cards = new PgScorecardStore(pg.client);
    runs = new PgRunStore(pg.client);
  });
  afterAll(async () => pg?.close());

  const pass = (over: Partial<ScoringPass> = {}): ScoringPass => ({
    passId: "pass-A",
    epoch: 1,
    leaseUntil: "2999-01-01T00:00:00.000Z",
    heartbeatAt: "2026-01-01T00:00:00.000Z",
    targetRevision: 1,
    baseRevision: 0,
    judges: [],
    startedAt: "2026-01-01T00:00:00.000Z",
    status: "running",
    ...over,
  });

  async function seed(): Promise<string> {
    const id = trustId("sc-own");
    const record: ScorecardRecord = {
      id,
      tenant: "trust",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      status: "succeeded",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await cards.create(record);
    return id;
  }

  // A Score is measured | unmeasured — only the measured variant carries a value, so the read narrows
  // rather than asserting past what the contract promises.
  const firstValue = (record: RunRecord | undefined): number | undefined => {
    const score = record?.result?.scores?.[0];
    return typeof score === "object" && score !== null && "value" in score
      ? (score as { value: number }).value
      : undefined;
  };

  it("gives the pass to exactly ONE of two claimants racing on the same empty marker", async () => {
    const id = await seed();
    const [a, b] = await Promise.all([
      cards.update(id, { scoringPass: pass({ passId: "A" }) }, undefined, { expectScoringPassId: null }),
      cards.update(id, { scoringPass: pass({ passId: "B" }) }, undefined, { expectScoringPassId: null }),
    ]);
    expect([a, b].filter((r) => r !== undefined)).toHaveLength(1);
    expect(["A", "B"]).toContain((await cards.get(id))?.scoringPass?.passId);
  });

  it("hands the plane to a takeover, and the old owner can no longer renew or settle", async () => {
    const id = await seed();
    await cards.update(id, { scoringPass: pass({ passId: "A" }) }, undefined, { expectScoringPassId: null });
    const took = await cards.update(id, { scoringPass: pass({ passId: "B", epoch: 2 }) }, undefined, {
      expectScoringPassId: "A",
    });
    expect(took).toBeDefined();
    const stale = await cards.update(id, { updatedAt: "2026-01-02T00:00:00.000Z" }, undefined, {
      expectScoringPassId: "A",
    });
    expect(stale).toBeUndefined();
  });

  it("refuses a superseded pass's child write — before AND after the winner settles", async () => {
    const id = await seed();
    const childId = trustId("run-own");
    await cards.update(id, { scoringPass: pass({ passId: "A" }) }, undefined, { expectScoringPassId: null });
    const result = {
      caseId: "c1",
      harness: "h@1",
      durationMs: 1,
      trace: [],
      snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "0".repeat(40) },
      scores: [],
    };
    await runs.create({
      id: childId,
      tenant: "trust",
      status: "succeeded",
      harness: { id: "h", version: "1" },
      dataset: { id: "d", version: "1.0.0" },
      caseId: "c1",
      scorecardId: id,
      result,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as unknown as RunRecord);

    const owned = await runs.update(
      childId,
      { result: { ...result, scores: [{ graderId: "g", metric: "m", value: 1 }] } } as Partial<RunRecord>,
      undefined,
      { scorecardId: id, passId: "A" },
    );
    expect(owned).toBeDefined();

    await cards.update(id, { scoringPass: pass({ passId: "B", epoch: 2 }) }, undefined, {
      expectScoringPassId: "A",
    });
    const superseded = await runs.update(
      childId,
      { result: { ...result, scores: [{ graderId: "g", metric: "m", value: 0 }] } } as Partial<RunRecord>,
      undefined,
      { scorecardId: id, passId: "A" },
    );
    expect(superseded).toBeUndefined();

    // The winner SETTLES — the marker (the read guard) is gone and the plane is readable again. A pass that
    // wakes now meets nothing but the fence, which is the whole reason the fence is in the write statement.
    await cards.update(id, { scoringPass: null }, undefined, { expectScoringPassId: "B" });
    const afterSettle = await runs.update(
      childId,
      { result: { ...result, scores: [{ graderId: "g", metric: "m", value: 0 }] } } as Partial<RunRecord>,
      undefined,
      { scorecardId: id, passId: "A" },
    );
    expect(afterSettle).toBeUndefined();
    expect(firstValue(await runs.get(childId))).toBe(1); // the winner's judgment, untouched
  });

  it("refuses a stale writer whose epoch a later pass reused (settle → new claim → old writer)", async () => {
    const id = await seed();
    await cards.update(id, { scoringPass: pass({ passId: "A", epoch: 1 }) }, undefined, {
      expectScoringPassId: null,
    });
    await cards.update(id, { scoringPass: null }, undefined, { expectScoringPassId: "A" });
    await cards.update(id, { scoringPass: pass({ passId: "B", epoch: 1 }) }, undefined, {
      expectScoringPassId: null,
    });
    expect((await cards.get(id))?.scoringPass?.epoch).toBe(1); // the counter restarted — the ABA condition

    const byEpoch = await cards.update(id, { updatedAt: "2026-01-02T00:00:00.000Z" }, undefined, {
      expectScoringPassEpoch: 1,
    });
    expect(byEpoch).toBeDefined(); // an epoch-only guard would have admitted the stale writer
    const byIdentity = await cards.update(id, { updatedAt: "2026-01-03T00:00:00.000Z" }, undefined, {
      expectScoringPassId: "A",
    });
    expect(byIdentity).toBeUndefined(); // identity is the fence
  });
});
