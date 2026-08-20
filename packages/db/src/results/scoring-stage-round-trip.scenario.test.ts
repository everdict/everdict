import {
  type JudgeRegistry,
  type JudgeRunner,
  ScorecardService,
  type ScorecardServiceDeps,
  type StagedJudgment,
} from "@everdict/application-control";
import type { CaseResult, JudgeSpec, Score, ScorecardRecord } from "@everdict/contracts";
import { ScoreSchema } from "@everdict/contracts";
import { CURRENT_STAGE_PARITY_VERSION, contentDigest } from "@everdict/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type PgPool, type SqlClient, makePool, sqlClient } from "../client.js";
import { migrate } from "../migrate.js";
import { PgScorecardStore } from "./pg-scorecard-store.js";
import { PgScoringStageStore } from "./scoring-stage-store.js";

// Live E2E — the scoring stage against a REAL Postgres (docs/architecture/scoring-plane-revisions.md).
// Requires real infra, so skip when env is unset (CI-safe). Locally:
//   EVERDICT_E2E_DATABASE_URL=postgresql://everdict:everdict@127.0.0.1:5434/everdict \
//   pnpm --filter @everdict/db test scoring-stage-round-trip.scenario
//
// WHY THIS NEEDS A DATABASE AND A FAKE CANNOT DO IT.
//
// The stage promotion's whole precondition is that staged bytes and plane bytes AGREE, decided by a canonical
// digest over both. The two sides travel different storage paths on purpose: the plane's rows come back
// through `ScoreSchema.parse` (declaration key order, `status: "measured"` defaulted in), while the staged
// rows come back as raw jsonb — Postgres key order, no defaults, numeric and unicode handling that is
// Postgres's rather than V8's. A fake `SqlClient` returns the object it was handed, so it proves the SQL text
// and nothing about the round trip; the InMemory twin returns the very array that was staged, which is not a
// round trip at all. Every green parity report the fleet gate will eventually read is a claim about THIS
// boundary, and until it is exercised against a real jsonb column the claim rests on a store that cannot
// disagree with itself.
const DATABASE_URL = process.env.EVERDICT_E2E_DATABASE_URL;

// The digest the parity comparison actually uses (`canonicalScores` in the score service): parse both sides
// through the same schema, sort by metric — array order is transport, not content — and digest canonically.
// Spelled here rather than imported because it is the thing under test: a copy that drifted would make this
// scenario certify a comparison nobody performs.
const canonical = (scores: readonly Score[]): string =>
  contentDigest(scores.map((s) => ScoreSchema.parse(s)).sort((a, b) => a.metric.localeCompare(b.metric)));

// Every Score VARIANT, including the fields a naive round trip loses: an implicit `status` (a producer
// literal writes none, the schema defaults it), a categorical `label`, an object-valued `detail`, the
// unmeasured retry bookkeeping, and a unicode metric that exercises the text encoding on both sides.
const richScores = (judgeId: string): Score[] => [
  { graderId: judgeId, metric: `judge:${judgeId}`, value: 0.5, pass: true, label: "gold" },
  {
    graderId: judgeId,
    metric: `judge:${judgeId}:정확도`,
    value: 1,
    detail: { reasoning: "the agent wrote ok.txt", evidence: ["step 3"] },
  },
  {
    graderId: judgeId,
    metric: `judge:${judgeId}:coverage`,
    status: "unmeasured",
    reason: "grader_error",
    retryable: true,
    attempts: 2,
    detail: "transport reset",
  },
];

const scenarioId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!DATABASE_URL)("the scoring stage over real Postgres jsonb", () => {
  if (!DATABASE_URL) return; // type narrowing (separate from skipIf)
  let pool: PgPool;
  let client: SqlClient;
  const written: string[] = [];

  beforeAll(async () => {
    pool = makePool(DATABASE_URL);
    client = sqlClient(pool);
    await migrate(client); // idempotent by contract
  });

  afterAll(async () => {
    for (const id of written) {
      await client.query("DELETE FROM everdict_scoring_stage WHERE scorecard_id = $1", [id]).catch(() => undefined);
      await client.query("DELETE FROM everdict_scorecards WHERE id = $1", [id]).catch(() => undefined);
    }
    await pool?.end();
  });

  it("returns staged judgments digest-identically to what was staged — every variant, through jsonb", async () => {
    const stage = new PgScoringStageStore(client);
    const scorecardId = scenarioId("sc-stage");
    const passId = scenarioId("pass");
    const entries: StagedJudgment[] = [
      { caseKey: "c1#0", judgeId: "a", scores: richScores("a") },
      { caseKey: "c1#1", judgeId: "a", scores: richScores("a") },
      { caseKey: "c2#0", judgeId: "b", scores: richScores("b") },
    ];

    const accepted = await stage.stage(scorecardId, passId, entries);
    const read = await stage.staged(scorecardId, passId);

    expect(accepted).toHaveLength(3);
    expect(read.map((row) => [row.caseKey, row.judgeId])).toEqual([
      ["c1#0", "a"],
      ["c1#1", "a"],
      ["c2#0", "b"],
    ]);
    // The claim the promotion rests on, stated as the comparison itself performs it.
    for (const row of read) {
      const source = entries.find((e) => e.caseKey === row.caseKey && e.judgeId === row.judgeId);
      expect(source).toBeDefined();
      expect(canonical(row.scores)).toBe(canonical(source?.scores ?? []));
    }
    expect(await stage.clear(scorecardId, passId)).toBe(3);
  });

  it("one re-score through the Pg stores settles with a promotion-safe parity observation", async () => {
    // The end-to-end claim: a pass judges, dual-writes, and its own settle compares the two through the real
    // column. An EMBED group deliberately (no child runs) — the shape whose judgments never reached the stage
    // at all until the write was hoisted out of the carrier guard (arch-review 44 ①), so this is also where a
    // regression there would show up as `missingFromStage` on a live database.
    const store = new PgScorecardStore(client);
    const stage = new PgScoringStageStore(client);
    const scorecardId = scenarioId("sc-rescore");
    written.push(scorecardId);

    const results: CaseResult[] = ["c1", "c2"].map((caseId) => ({
      caseId,
      harness: "h@1",
      trace: [],
      snapshot: { kind: "prompt", output: "done" },
      scores: [{ graderId: "tests-pass", metric: "tests_pass", value: 1, pass: true }],
    }));
    const record: ScorecardRecord = {
      id: scorecardId,
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      status: "succeeded",
      scorecard: { suiteId: "d", harness: "h@1", results },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as ScorecardRecord;
    await store.create(record);

    const spec: JudgeSpec = {
      kind: "model",
      id: "a",
      version: "1.0.0",
      provider: "anthropic",
      model: "m",
      rubric: "good?",
      inputs: ["trace"],
      tags: [],
    };
    const judges = {
      async has() {
        return true;
      },
      async get() {
        return spec;
      },
      async versions() {
        return [];
      },
      async ownVersions() {
        return [];
      },
      async list() {
        return [];
      },
      async versionTags() {
        return {};
      },
      async creatorOfVersion() {
        return undefined;
      },
    } as unknown as JudgeRegistry;
    // A judge that returns the full variety — the bytes whose survival is the point.
    // The port answers an INVOCATION now (arch-review 58 follow-through): the verdict plus whether the
    // judge's own execution could be sealed. This scenario is about the SCORE BYTES surviving a round trip,
    // and it has no trajectory store, which is exactly what `not_applicable` means.
    const judgeRunner: JudgeRunner = {
      run: async () => ({ scores: richScores("a"), evidence: "not_applicable" }),
    };
    const deps = {
      dispatcher: { dispatch: async () => ({}) },
      store,
      datasets: {
        async get() {
          throw new Error("no registry dataset — the shell fallback is what an ad-hoc group uses");
        },
      },
      judges,
      judgeRunner,
      scoringStage: stage,
    } as unknown as ScorecardServiceDeps;

    await new ScorecardService(deps).scoreGroup({
      tenant: "acme",
      id: scorecardId,
      judges: [{ id: "a", version: "1.0.0" }],
    });
    // The in-process pass settles asynchronously; poll rather than sleep a fixed amount.
    let settled: ScorecardRecord | undefined;
    for (let i = 0; i < 100 && settled?.scoring === undefined; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      settled = await store.get(scorecardId);
    }

    const parity = settled?.scoring?.at(-1)?.stageParity;
    expect(parity).toBeDefined();
    // Two cases × one judge = two staged units, all of them agreeing with the plane the pass settled. Any
    // jsonb-induced difference — a dropped default, a reordered key, a lost unicode metric — lands here as a
    // mismatch, which is exactly the signal the fleet gate reads.
    expect(parity).toMatchObject({
      version: CURRENT_STAGE_PARITY_VERSION,
      completed: true,
      expectedJudged: 2,
      staged: 2,
      matched: 2,
      missingFromStage: 0,
      mismatched: 0,
      orphaned: 0,
      promotionSafe: true,
    });
    // …and the settle collected the stage only AFTER recording that observation — the lifetime invariant,
    // asked of the table rather than of one pass id, so it also catches rows a takeover left behind.
    const leftover = await client.query("SELECT 1 FROM everdict_scoring_stage WHERE scorecard_id = $1", [scorecardId]);
    expect(leftover.rows).toEqual([]);
  });
});
