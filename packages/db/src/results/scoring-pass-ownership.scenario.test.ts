import { type ScorecardRecord, type ScoringPass, scoringPassReclaimable } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { makePool, sqlClient } from "../client.js";
import { migrate } from "../migrate.js";
import { PgRunStore } from "./pg-run-store.js";
import { PgScorecardStore } from "./pg-scorecard-store.js";

// Live E2E — the scoring-pass ownership invariant against REAL Postgres (arch-review 8 §16).
//
// The unit tests prove the SERVICE refuses a superseded pass. They cannot prove the thing that actually
// matters here, because they replace the store: whether the claim's compare-and-swap and the child-write
// fence hold when two writers race inside the database. A guard that is a jsonb condition in one statement
// and a guard that is an `if` in a fake are different guarantees, and only one of them ships.
//
// Requires a Postgres this test may migrate into. CI-safe (skipped when unset). Locally:
//   EVERDICT_E2E_DATABASE_URL=postgresql://user:pass@host:5435/everdict_trust_pass \
//   pnpm --filter @everdict/db test scoring-pass-ownership.scenario
const URL = process.env.EVERDICT_E2E_DATABASE_URL;

describe.skipIf(!URL)("scoring-pass ownership — live Postgres (arch-review 8 P0)", () => {
  if (!URL) return; // type narrowing (separate from skipIf)
  const client = sqlClient(makePool(URL));
  const cards = new PgScorecardStore(client);
  const runs = new PgRunStore(client);

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

  async function seed(id: string): Promise<ScorecardRecord> {
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
    return record;
  }

  it("migrates the schema this invariant lives in", async () => {
    await migrate(client);
    const { rows } = await client.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name='everdict_scorecards' and column_name='scoring_pass'",
    );
    expect(rows).toHaveLength(1);
  });

  it("gives the pass to exactly ONE of two claimants racing on the same empty marker", async () => {
    const id = `sc-claim-${Date.now()}`;
    await seed(id);
    // Both replicas read "no pass" and both write. The CAS decides — not the write order.
    const [a, b] = await Promise.all([
      cards.update(id, { scoringPass: pass({ passId: "A", epoch: 1 }) }, undefined, {
        expectScoringPassEpoch: null,
      }),
      cards.update(id, { scoringPass: pass({ passId: "B", epoch: 1 }) }, undefined, {
        expectScoringPassEpoch: null,
      }),
    ]);
    const winners = [a, b].filter((r) => r !== undefined);
    expect(winners).toHaveLength(1);
    const live = await cards.get(id);
    expect(["A", "B"]).toContain(live?.scoringPass?.passId);
    expect(live?.scoringPass?.epoch).toBe(1);
  });

  it("lets a takeover MOVE the epoch, which is what invalidates the old owner's writes", async () => {
    const id = `sc-takeover-${Date.now()}`;
    await seed(id);
    await cards.update(id, { scoringPass: pass({ passId: "A", epoch: 1 }) }, undefined, {
      expectScoringPassEpoch: null,
    });
    // A reclaimable marker (expired lease) is taken over by stating the epoch the claimant READ.
    const expired = pass({ passId: "A", epoch: 1, leaseUntil: "2020-01-01T00:00:00.000Z" });
    expect(scoringPassReclaimable(expired, "2026-01-01T00:00:00.000Z")).toBe(true);
    await cards.update(id, { scoringPass: expired }, undefined, { expectScoringPassEpoch: 1 });
    const took = await cards.update(id, { scoringPass: pass({ passId: "B", epoch: 2 }) }, undefined, {
      expectScoringPassEpoch: 1,
    });
    expect(took).toBeDefined();
    // …and the OLD owner, still holding epoch 1, can no longer renew or settle.
    const stale = await cards.update(id, { updatedAt: "2026-01-02T00:00:00.000Z" }, undefined, {
      expectScoringPassEpoch: 1,
    });
    expect(stale).toBeUndefined();
  });

  it("REFUSES a superseded pass's child write — evaluated in the write statement, not before it", async () => {
    const id = `sc-fence-${Date.now()}`;
    const childId = `run-fence-${Date.now()}`;
    await seed(id);
    await cards.update(id, { scoringPass: pass({ passId: "A", epoch: 1 }) }, undefined, {
      expectScoringPassEpoch: null,
    });
    await runs.create({
      id: childId,
      tenant: "trust",
      status: "succeeded",
      harness: { id: "h", version: "1" },
      dataset: { id: "d", version: "1.0.0" },
      caseId: "c1",
      scorecardId: id,
      result: {
        caseId: "c1",
        harness: "h@1",
        durationMs: 1,
        trace: [],
        snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "0".repeat(40) },
        scores: [],
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as never);

    // The owner writes.
    const owned = await runs.update(
      childId,
      {
        result: {
          caseId: "c1",
          harness: "h@1",
          durationMs: 1,
          trace: [],
          snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "0".repeat(40) },
          scores: [{ graderId: "g", metric: "m", value: 1 }],
        } as never,
      },
      undefined,
      { scorecardId: id, passId: "A" },
    );
    expect(owned).toBeDefined();

    // A takeover happens, then the OLD pass wakes up and writes.
    await cards.update(id, { scoringPass: pass({ passId: "B", epoch: 2 }) }, undefined, {
      expectScoringPassEpoch: 1,
    });
    const superseded = await runs.update(
      childId,
      {
        result: {
          caseId: "c1",
          harness: "h@1",
          durationMs: 1,
          trace: [],
          snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "0".repeat(40) },
          scores: [{ graderId: "g", metric: "m", value: 0 }],
        } as never,
      },
      undefined,
      { scorecardId: id, passId: "A" },
    );
    expect(superseded).toBeUndefined();
    const child = await runs.get(childId);
    expect(child?.result?.scores?.[0]?.value).toBe(1); // the winner's judgment, untouched

    // …and the interleaving the READ GUARD cannot see: the winner SETTLES (marker cleared, plane readable
    // again) and only then does the loser wake. Nothing but the fence is left to refuse it.
    await cards.update(id, { scoringPass: null }, undefined, { expectScoringPassEpoch: 2 });
    const afterSettle = await runs.update(
      childId,
      {
        result: {
          caseId: "c1",
          harness: "h@1",
          durationMs: 1,
          trace: [],
          snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "0".repeat(40) },
          scores: [{ graderId: "g", metric: "m", value: 0 }],
        } as never,
      },
      undefined,
      { scorecardId: id, passId: "A" },
    );
    expect(afterSettle).toBeUndefined();
    const settled = await runs.get(childId);
    expect(settled?.result?.scores?.[0]?.value).toBe(1);
  });
});
