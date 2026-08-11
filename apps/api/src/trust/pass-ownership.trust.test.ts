import type { RunRecord, ScorecardRecord, ScoringPass } from "@everdict/contracts";
import { PgRunStore, PgScorecardStore, PgScoringStageStore } from "@everdict/db";
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
      { scoring: { scorecardId: id, passId: "A" } },
    );
    expect(owned).toBeDefined();

    await cards.update(id, { scoringPass: pass({ passId: "B", epoch: 2 }) }, undefined, {
      expectScoringPassId: "A",
    });
    const superseded = await runs.update(
      childId,
      { result: { ...result, scores: [{ graderId: "g", metric: "m", value: 0 }] } } as Partial<RunRecord>,
      undefined,
      { scoring: { scorecardId: id, passId: "A" } },
    );
    expect(superseded).toBeUndefined();

    // The winner SETTLES — the marker (the read guard) is gone and the plane is readable again. A pass that
    // wakes now meets nothing but the fence, which is the whole reason the fence is in the write statement.
    await cards.update(id, { scoringPass: null }, undefined, { expectScoringPassId: "B" });
    const afterSettle = await runs.update(
      childId,
      { result: { ...result, scores: [{ graderId: "g", metric: "m", value: 0 }] } } as Partial<RunRecord>,
      undefined,
      { scoring: { scorecardId: id, passId: "A" } },
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

// Trust suite — TRUST-52.
//
// A SUPERSEDED ATTEMPT OF THE SAME PASS CANNOT OVERWRITE THE CURRENT ONE'S JUDGMENT. TRUST-42 certifies that
// a superseded PASS is fenced out; this is the level below it, and the pass fence structurally cannot reach:
// Temporal retries an activity INSIDE one pass, so a timed-out attempt whose provider call is still running
// and its replacement both present the same passId and both clear every guard. Only a real Postgres can
// certify the arbitration — it is a conditional upsert (`DO UPDATE … WHERE attempt <= EXCLUDED.attempt`), and
// an in-memory fake serializes by construction.
describe.skipIf(!TRUST_PG_ENABLED)("TRUST-52 — the current attempt owns the judgment (real Postgres)", () => {
  let pg: TrustPg;
  let stage: PgScoringStageStore;

  beforeAll(async () => {
    pg = await openTrustPg();
    stage = new PgScoringStageStore(pg.client);
  });
  afterAll(async () => pg?.close());

  const judgment = (value: number, generation: number, attempt: number) => ({
    caseKey: "c1#0",
    judgeId: "quality",
    scores: [{ graderId: "q", metric: "judge:quality", value, pass: value === 1 }],
    claim: { generation, attempt },
  });

  it("a LATE completion from a replaced attempt is refused, and the current judgment stands", async () => {
    const id = trustId("sc-attempt");
    // Attempt 2 answered first (attempt 1 timed out and is still running somewhere).
    await expect(stage.stage(id, "pass-A", [judgment(1, 0, 2)])).resolves.toHaveLength(1);
    // …and now attempt 1 comes back with the opposite verdict. Both are legal; both hold the same passId.
    await expect(stage.stage(id, "pass-A", [judgment(0, 0, 1)])).resolves.toEqual([]);
    const staged = await stage.staged(id, "pass-A");
    expect(staged).toHaveLength(1);
    expect(staged[0]?.claim?.attempt).toBe(2);
    expect((staged[0]?.scores?.[0] as { value: number }).value).toBe(1); // the current attempt's judgment
    await stage.clear(id, "pass-A");
  });

  it("a RETRY supersedes — the replacement holds the right to write, and says so", async () => {
    const id = trustId("sc-retry");
    await expect(stage.stage(id, "pass-A", [judgment(0, 0, 1)])).resolves.toHaveLength(1);
    const accepted = await stage.stage(id, "pass-A", [judgment(1, 0, 2)]);
    expect(accepted).toHaveLength(1); // returned, because the CARRIER write follows exactly this answer
    const staged = await stage.staged(id, "pass-A");
    expect((staged[0]?.scores?.[0] as { value: number }).value).toBe(1);
    await stage.clear(id, "pass-A");
  });

  it("arbitrates per (case, JUDGE) — a retry of one judge leaves its neighbour's row untouched", async () => {
    const id = trustId("sc-judge");
    await stage.stage(id, "pass-A", [
      judgment(1, 0, 1),
      {
        caseKey: "c1#0",
        judgeId: "safety",
        scores: [{ graderId: "s", metric: "judge:safety", value: 1, pass: true }],
        claim: { generation: 0, attempt: 1 },
      },
    ]);
    await stage.stage(id, "pass-A", [judgment(0, 0, 2)]);
    const staged = await stage.staged(id, "pass-A");
    expect(staged).toHaveLength(2);
    expect(staged.find((e) => e.judgeId === "safety")?.claim?.attempt).toBe(1);
    expect(staged.find((e) => e.judgeId === "quality")?.claim?.attempt).toBe(2);
    await stage.clear(id, "pass-A");
  });
});

// Trust suite — TRUST-54.
//
// A CONTINUE-AS-NEW MUST NOT MAKE A PASS'S OWN NEXT JUDGMENT LOOK STALE. This is the lifetime half of
// "an authority token has the scope and lifetime of the mutation it governs": Temporal's `attempt` is
// monotonic per ACTIVITY EXECUTION, while a stage row lives for the whole PASS. After a rotation the
// workflow re-plans and schedules the still-pending case as a NEW execution starting at attempt 1 — so an
// attempt-only claim refused the fresh judgment as stale and the case could never finish. Certified against
// real Postgres because the ordering is a row-wise comparison inside a conditional upsert.
describe.skipIf(!TRUST_PG_ENABLED)("TRUST-54 — the claim spans the pass, not one execution (real Postgres)", () => {
  let pg: TrustPg;
  let stage: PgScoringStageStore;

  beforeAll(async () => {
    pg = await openTrustPg();
    stage = new PgScoringStageStore(pg.client);
  });
  afterAll(async () => pg?.close());

  const row = (value: number, generation: number, attempt: number) => ({
    caseKey: "c1#0",
    judgeId: "quality",
    scores: [{ graderId: "q", metric: "judge:quality", value, pass: value === 1 }],
    claim: { generation, attempt },
  });

  it("a rotation's attempt 1 supersedes the previous execution's attempt 2", async () => {
    const id = trustId("sc-gen");
    await expect(stage.stage(id, "pass-A", [row(0, 0, 2)])).resolves.toHaveLength(1);
    // continue-as-new → generation 1, Temporal's attempt counter starts over at 1.
    await expect(stage.stage(id, "pass-A", [row(1, 1, 1)])).resolves.toHaveLength(1);
    const staged = await stage.staged(id, "pass-A");
    expect(staged[0]?.claim).toEqual({ generation: 1, attempt: 1 });
    expect((staged[0]?.scores?.[0] as { value: number }).value).toBe(1);
    await stage.clear(id, "pass-A");
  });

  it("and no attempt of an earlier generation can ever come back over it", async () => {
    const id = trustId("sc-gen-late");
    await stage.stage(id, "pass-A", [row(1, 1, 1)]);
    await expect(stage.stage(id, "pass-A", [row(0, 0, 9)])).resolves.toEqual([]);
    const staged = await stage.staged(id, "pass-A");
    expect((staged[0]?.scores?.[0] as { value: number }).value).toBe(1);
    await stage.clear(id, "pass-A");
  });
});

// Trust suite — TRUST-82 · TRUST-83.
//
// A PASS DECLARED DEAD LOSES ITS AUTHORITY, NOT JUST ITS FUTURE.
//
// `failScore` flips a terminally-failed pass's marker to `failed` and collects its stage, and the code beside
// it says such a pass "will never write again". Nothing enforced that: every fence compared the passId and
// nothing else, so a late activity of a dead pass — its provider call still in flight when the workflow died —
// cleared each guard and wrote its judgment onto the child, and a late finalize appended a revision over a
// plane whose owner had already been declared abandoned, clearing the marker a takeover was waiting on.
//
// Identity answers "who is this"; status answers "may it still act". A terminal state has to be a CAPABILITY
// REVOCATION or the sentence is a comment. Certified against real Postgres because the enforcement is a
// predicate inside the write statements — checking it in the service alone leaves the check→write window it
// exists to close.
describe.skipIf(!TRUST_PG_ENABLED)("TRUST-82/83 — a failed pass may not write again (real Postgres)", () => {
  let pg: TrustPg;
  let cards: PgScorecardStore;
  let runs: PgRunStore;

  beforeAll(async () => {
    pg = await openTrustPg();
    cards = new PgScorecardStore(pg.client);
    runs = new PgRunStore(pg.client);
  });
  afterAll(async () => pg?.close());

  const deadPass = (passId: string): ScoringPass => ({
    passId,
    epoch: 1,
    leaseUntil: "2999-01-01T00:00:00.000Z", // a LIVE lease: it is the status, not the clock, that revokes
    heartbeatAt: "2026-01-01T00:00:00.000Z",
    targetRevision: 1,
    baseRevision: 0,
    judges: [],
    startedAt: "2026-01-01T00:00:00.000Z",
    status: "failed",
    failedAt: "2026-01-01T00:00:00.000Z",
    failure: "the scoring workflow failed",
  });

  async function seedDead(): Promise<{ id: string; passId: string }> {
    const id = trustId("sc-dead");
    const passId = trustId("pass-dead");
    await cards.create({
      id,
      tenant: "trust",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      status: "succeeded",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as ScorecardRecord);
    await cards.update(id, { scoringPass: deadPass(passId) }, undefined, { expectScoringPassId: null });
    return { id, passId };
  }

  it("TRUST-82 — a late SETTLE of a dead pass is refused, so its revision never lands", async () => {
    const { id, passId } = await seedDead();
    const settled = await cards.update(id, { scoringPass: null, updatedAt: "2026-01-02T00:00:00.000Z" }, undefined, {
      expectScoringPassId: passId,
    });
    expect(settled).toBeUndefined(); // pre-fix: committed, because passId still matched
    // …and the marker is still there for a takeover to reclaim, which is what makes the refusal recoverable
    // rather than merely obstructive.
    expect((await cards.get(id))?.scoringPass?.status).toBe("failed");
  });

  it("TRUST-83 — a late CHILD WRITE of a dead pass is refused by the cross-row fence", async () => {
    const { id, passId } = await seedDead();
    const runId = trustId("run-dead");
    await runs.create({
      id: runId,
      tenant: "trust",
      harness: { id: "h", version: "1" },
      caseId: "c1",
      parentScorecardId: id,
      status: "succeeded",
      result: {
        caseId: "c1",
        harness: "h@1",
        trace: [],
        snapshot: { kind: "prompt", output: "done" },
        scores: [{ graderId: "j", metric: "judge:j", value: 1, pass: true }],
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as unknown as RunRecord);
    const written = await runs.update(
      runId,
      {
        result: {
          caseId: "c1",
          harness: "h@1",
          trace: [],
          snapshot: { kind: "prompt", output: "done" },
          scores: [{ graderId: "j", metric: "judge:j", value: 0, pass: false }],
        },
      } as unknown as Partial<RunRecord>,
      undefined,
      { scoring: { scorecardId: id, passId } },
    );
    expect(written).toBeUndefined();
    // The plane is exactly as the live pass left it.
    const kept = (await runs.get(runId))?.result?.scores?.[0];
    expect(kept !== undefined && "value" in kept ? kept.value : undefined).toBe(1);
  });

  it("…and a TAKEOVER still reclaims the dead marker — revocation must not also block recovery", async () => {
    const { id, passId } = await seedDead();
    const took = await cards.update(
      id,
      { scoringPass: { ...deadPass(passId), passId: "successor", status: "running", epoch: 2 } },
      undefined,
      { expectScoringPassId: passId, expectScoringPassReclaimable: true },
    );
    expect(took).toBeDefined();
    expect((await cards.get(id))?.scoringPass?.passId).toBe("successor");
  });
});
