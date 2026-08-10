import { type DatasetRegistry, type JudgeRegistry, ScorecardService } from "@everdict/application-control";
import type { JudgeSpec, RunRecord, Score, ScorecardRecord, ScoringPass } from "@everdict/contracts";
import { PgRunStore, PgScorecardStore, PgScoringStageStore } from "@everdict/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRUST_PG_ENABLED, type TrustPg, openTrustPg, trustId } from "./trust-context.js";

// Trust suite (docs/trust-certification.md) — TRUST-53 · TRUST-55.
//
// THE CARRIER OBEYS THE ARBITER, PER JUDGE, OR IT DOES NOT WRITE AT ALL.
//
// TRUST-52 and TRUST-54 certify that the STAGE arbitrates correctly. That is a statement about a table. This
// is the statement that actually protects the score plane: the production write path must preserve the
// arbiter's answer at the arbiter's own granularity, and must refuse to proceed when the arbiter cannot give
// one. Both were false at the moment the stage became an authority —
//
//   TRUST-53  the per-(case, judge) verdict was collapsed into a case-level boolean, so ONE accepted judge
//             let the whole case plane through and a REJECTED judge's bytes rode in on its neighbour's win.
//   TRUST-55  the stage call was `.catch(() => undefined)` and the write proceeded, so "the arbiter is down"
//             read as "you won" — restoring the race it settles exactly when it is least observable.
//
// Driven through the PUBLIC seam (`ScorecardService.runScoreCase`) against a real Postgres stage, run store
// and scorecard store: a fake arbiter deciding by fiat cannot certify that the composition preserves an
// answer it never actually computed.
describe.skipIf(!TRUST_PG_ENABLED)("TRUST-53/55 — the carrier obeys the arbiter (real Postgres)", () => {
  let pg: TrustPg;
  let cards: PgScorecardStore;
  let runs: PgRunStore;
  let stage: PgScoringStageStore;

  beforeAll(async () => {
    pg = await openTrustPg();
    cards = new PgScorecardStore(pg.client);
    runs = new PgRunStore(pg.client);
    stage = new PgScoringStageStore(pg.client);
  });
  afterAll(async () => pg?.close());

  const NOW = "2026-08-09T00:00:00.000Z";
  const JUDGES = [
    { id: "alpha", version: "1.0.0" },
    { id: "beta", version: "1.0.0" },
  ];
  const CASE_ID = "c1";
  const KEY = "c1#0"; // the child key the planner emits (caseId#trial) — the unit scoreCase is addressed by

  const verdict = (judge: string, value: number): Score => ({
    graderId: judge,
    metric: `judge:${judge}`,
    value,
    pass: value === 1,
  });

  const livePass = (passId: string): ScoringPass => ({
    passId,
    epoch: 1,
    leaseUntil: "2999-01-01T00:00:00.000Z",
    heartbeatAt: NOW,
    targetRevision: 1,
    baseRevision: 0,
    judges: [],
    startedAt: NOW,
    status: "running",
  });

  // The exact production interleaving. A pass strips the selected judges first, so the RECORD's plane shows
  // both judges pending — that is what this attempt read when it started. While it was judging, the other
  // attempt finished and wrote its verdicts onto the CHILD RUN, which is the plane a write-back actually
  // merges onto. So: pending in the record, already-written on the child. Nothing here is contrived; it is
  // simply what "two attempts of one pass overlap" looks like from inside the second one.
  async function seed(passId: string): Promise<{ id: string; runId: string }> {
    const id = trustId("sc-arb");
    const runId = trustId("run-arb");
    await runs.create({
      id: runId,
      tenant: "trust",
      harness: { id: "h", version: "1" },
      caseId: CASE_ID,
      parentScorecardId: id, // the link the write-back resolves children by
      status: "succeeded",
      result: {
        caseId: CASE_ID,
        harness: "h@1",
        trace: [{ t: 0, kind: "message", role: "assistant", text: "done" }],
        snapshot: { kind: "prompt", output: "done" },
        scores: [verdict("alpha", 1), verdict("beta", 1)],
      },
      createdAt: NOW,
      updatedAt: NOW,
    } as unknown as RunRecord);
    const record: ScorecardRecord = {
      id,
      tenant: "trust",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      status: "succeeded",
      runIds: [runId],
      scoringPass: livePass(passId),
      scorecard: {
        suiteId: "d@1.0.0",
        harness: "h@1",
        results: [
          {
            caseId: CASE_ID,
            harness: "h@1",
            trace: [{ t: 0, kind: "message", role: "assistant", text: "done" }],
            snapshot: { kind: "prompt", output: "done" },
            scores: [], // stripped by prepareScore — both judges are pending for this attempt
          },
        ],
      },
      createdAt: NOW,
      updatedAt: NOW,
    } as unknown as ScorecardRecord;
    await cards.create(record);
    return { id, runId };
  }

  // A judge runner that always answers 0 — "this attempt re-judged both and disagrees". Whether those bytes
  // reach the carrier is exactly what the arbiter decides.
  const service = (opts: { stage?: PgScoringStageStore | undefined; brokenStage?: boolean }): ScorecardService => {
    const judges = {
      async get(_t: string, id: string, version: string): Promise<JudgeSpec> {
        return {
          kind: "model",
          id,
          version,
          provider: "anthropic",
          model: "test-model",
          rubric: "is it right?",
          inputs: ["trace"],
          tags: [],
        };
      },
      async versions() {
        return ["1.0.0"];
      },
    };
    const broken: PgScoringStageStore = {
      async stage() {
        throw new Error("stage unavailable");
      },
      async staged() {
        return [];
      },
      async clear() {
        return 0;
      },
    } as unknown as PgScoringStageStore;
    return new ScorecardService({
      dispatcher: {
        async dispatch() {
          throw new Error("no dispatch in this scenario");
        },
      },
      store: cards,
      runStore: runs,
      // Two-method stand-ins for the registries: only `get`/`versions` are on this path, and the scenario is
      // about arbitration rather than resolution. The dataset get THROWS on purpose — `effectiveDataset` falls
      // back to shell cases, which is the state a re-score of an already-run batch is in anyway.
      judges: judges as unknown as JudgeRegistry,
      datasets: {
        async get() {
          throw new Error("no dataset");
        },
        async versions() {
          return [];
        },
      } as unknown as DatasetRegistry,
      judgeRunner: {
        async run(spec: JudgeSpec): Promise<Score[]> {
          return [verdict(spec.id, 0)];
        },
      },
      ...(opts.brokenStage ? { scoringStage: broken } : opts.stage ? { scoringStage: opts.stage } : {}),
    });
  };

  it("TRUST-53 — an accepted judge's bytes land and a SUPERSEDED judge's neighbour row is untouched", async () => {
    const passId = trustId("pass");
    const { id, runId } = await seed(passId);
    // The winning attempt already staged BOTH judges under a higher claim than the one about to write.
    await stage.stage(id, passId, [
      { caseKey: KEY, judgeId: "alpha", scores: [verdict("alpha", 1)], claim: { generation: 0, attempt: 1 } },
      { caseKey: KEY, judgeId: "beta", scores: [verdict("beta", 1)], claim: { generation: 0, attempt: 9 } },
    ]);
    // …and now a later attempt of alpha (2 > 1, so it wins) arrives together with a LATE beta (2 < 9, so it
    // loses). One call, two judges, opposite verdicts from the arbiter.
    await service({ stage }).runScoreCase(id, KEY, JUDGES, "dana", passId, { generation: 0, attempt: 2 });

    const written = (await runs.get(runId))?.result?.scores ?? [];
    const alpha = written.find((s) => s.metric === "judge:alpha");
    const beta = written.find((s) => s.metric === "judge:beta");
    expect(alpha).toMatchObject({ value: 0 }); // this attempt won alpha — its judgment stands
    expect(beta).toMatchObject({ value: 1 }); // …and lost beta, which therefore never moved
    await stage.clear(id, passId);
  });

  it("TRUST-55 — an arbiter that cannot answer stops the write entirely: not one byte moves", async () => {
    const passId = trustId("pass-closed");
    const { id, runId } = await seed(passId);
    const before = (await runs.get(runId))?.result?.scores ?? [];
    await expect(
      service({ brokenStage: true }).runScoreCase(id, KEY, JUDGES, "dana", passId, { generation: 0, attempt: 1 }),
    ).rejects.toThrow(/stage unavailable/);
    // The activity fails, Temporal retries it, and the plane is exactly where it was. Fail-OPEN here would
    // have written this attempt's verdicts over a plane whose ownership nobody was able to check.
    expect((await runs.get(runId))?.result?.scores).toEqual(before);
  });
});
