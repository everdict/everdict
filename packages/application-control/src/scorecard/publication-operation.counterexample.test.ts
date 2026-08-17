import type { CaseResult, PublicationPlan, ScorecardExport, ScorecardRecord } from "@everdict/contracts";
import { contentDigest } from "@everdict/domain";
import { describe, expect, it, vi } from "vitest";
import { InMemoryPublicationOperationStore } from "../ports/publication-operation-store.js";
import type { ScorecardStore, ScorecardUpdateGuard } from "../ports/scorecard-store.js";
import { drainPublicationOperation, planPublicationOperation } from "./publication.js";
import type { AnalysisBundle } from "./scorecard-observability.js";

// ── OPERATION CARDINALITY EQUALS DECISION CARDINALITY (arch-review 53, Wave C) ───────────────────────
//
// Wave 4 moved the outward effects behind a plan that rides the terminal transaction, which fixed the ORDER.
// What it did not fix is the SHAPE: the plan lives in a single mutable field on the scorecard row
// (`publication?: PublicationPlan`), while the decisions it serves are plural. A scorecard has one initial
// settlement and any number of re-score settlements, and each of them owes its OWN artifact promotion and its
// OWN export — so several decisions share one slot.
//
// Two consequences follow directly, and neither is exotic; both are the ordinary interleaving of a re-score
// against a batch whose first publication has not drained yet:
//
//   · the second settle OVERWRITES the first plan, and the first settlement's export debt vanishes from the
//     row with nothing recording that it was owed;
//   · the fence is `expectPublicationState: "pending"`, which asks "is SOMETHING pending", not "is the plan
//     I read still the plan" — so a publisher holding the OLD plan passes the CAS against the NEW one and
//     writes its own receipt over a debt it never paid.
//
// And the export itself is at-least-once against the sink with no way for the sink to dedupe: `planPublication`
// mints an `idempotencyKey` that `drainPublication` never passes to `exportResults`, which does not accept one.
//
// The invariant these pin: one settlement, one publication operation, keyed by `(scorecardId, revision, passId)`
// and claimed by that exact id — never by "whatever is pending on the row".

const SCORECARD_ID = "sc-1";

const results = (marker: string): CaseResult[] => [
  {
    caseId: "c1",
    harness: "h@1",
    trace: [],
    snapshot: { kind: "prompt", output: marker },
    scores: [{ graderId: "tests-pass", metric: "tests_pass", value: 1, pass: true }],
  },
];

const bundle = (marker: string): AnalysisBundle => ({
  scorecardId: SCORECARD_ID,
  dataset: "d@1.0.0",
  harness: "h@1",
  summary: [],
  cases: [{ caseId: "c1", verdict: true, scores: results(marker)[0]?.scores ?? [] }],
  infra: { failedCases: 0, byClass: {}, byCode: {}, oom: 0, placementBlocked: 0 },
});

function record(plan: PublicationPlan | undefined, marker: string): ScorecardRecord {
  return {
    id: SCORECARD_ID,
    tenant: "acme",
    dataset: { id: "d", version: "1.0.0" },
    harness: { id: "h", version: "1" },
    status: "succeeded",
    ...(plan ? { publication: plan } : {}),
    scorecard: { suiteId: "d", harness: "h@1", results: results(marker) },
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-17T00:00:01.000Z",
  } as unknown as ScorecardRecord;
}

function fakeStore(initial: ScorecardRecord): { store: ScorecardStore; current: () => ScorecardRecord } {
  let held = initial;
  const store = {
    async update(id: string, patch: Partial<ScorecardRecord>, _events: unknown, guard?: ScorecardUpdateGuard) {
      if (id !== held.id) return undefined;
      if (guard?.expectPublicationState !== undefined && held.publication?.state !== guard.expectPublicationState)
        return undefined;
      held = { ...held, ...patch };
      return held;
    },
    async get() {
      return held;
    },
    async list() {
      return [held];
    },
  } as unknown as ScorecardStore;
  return { store, current: () => held };
}

const stagedOf = (marker: string) => ({
  revisionKey: `analyses/${SCORECARD_ID}/pass-${marker}.json`,
  key: `analyses/${SCORECARD_ID}/pass-${marker}.json`,
});
// A plan that owes only the EXPORT. The alias promotion needs an artifact store, and an unwired one leaves
// every plan owed for a reason that has nothing to do with the races below — it would mask them.
const exportOnly = () => ({ key: `analyses/${SCORECARD_ID}/x.json` });

const now = () => "2026-08-17T01:00:00.000Z";

// RED as of 186f9fd9: `expected undefined to be defined` — the second plan replaced the first in the single
// `publication` field, and the first settlement's owed export was gone from the record entirely.
describe("[R53 WAVE-C COUNTEREXAMPLE #14 — CLOSED] a re-score does not erase the previous settlement's debt", () => {
  it("keeps one owed operation per settlement", async () => {
    const operations = new InMemoryPublicationOperationStore();
    const initial = planPublicationOperation({
      scorecardId: SCORECARD_ID,
      bundle: bundle("initial"),
      staged: exportOnly() as never,
      passId: "initial-abc",
      scoringRevision: 1,
      exports: true,
      results: results("initial"),
      now: now(),
    });
    const rescore = planPublicationOperation({
      scorecardId: SCORECARD_ID,
      bundle: bundle("rescore"),
      staged: exportOnly() as never,
      passId: "rescore-def",
      scoringRevision: 2,
      exports: true,
      results: results("rescore"),
      now: now(),
    });
    if (!initial || !rescore) throw new Error("both settlements owe an export");
    await operations.open(initial);
    // The re-score settles while the initial publication is still owed — the ordinary case, because the
    // inline drain happens after the commit and a re-score can land in that window.
    await operations.open(rescore);

    const owed = await operations.listForScorecard(SCORECARD_ID);
    expect(owed.map((o) => o.settlement.passId)).toEqual(["initial-abc", "rescore-def"]);
    expect(
      owed.find((o) => o.settlement.passId === "initial-abc"),
      "the initial settlement's publication debt was overwritten by the re-score",
    ).toBeDefined();
  });
});

// RED as of 186f9fd9: `expected 'published' to be 'pending'` — publisher A's receipt landed on the row and the
// re-score's plan was gone, because the CAS only asked whether SOMETHING was pending.
describe("[R53 WAVE-C COUNTEREXAMPLE #15 — CLOSED] a publisher completes the plan it read, not whatever is pending", () => {
  it("a stale publisher cannot write its receipt over a newer settlement's operation", async () => {
    const operations = new InMemoryPublicationOperationStore();
    const initial = planPublicationOperation({
      scorecardId: SCORECARD_ID,
      bundle: bundle("initial"),
      staged: exportOnly() as never,
      passId: "initial-abc",
      scoringRevision: 1,
      exports: true,
      results: results("initial"),
      now: now(),
    });
    const rescore = planPublicationOperation({
      scorecardId: SCORECARD_ID,
      bundle: bundle("initial"),
      staged: exportOnly() as never,
      passId: "rescore-def",
      scoringRevision: 2,
      exports: true,
      results: results("initial"),
      now: now(),
    });
    if (!initial || !rescore) throw new Error("both settlements owe an export");
    await operations.open(initial);
    await operations.open(rescore);

    const { store } = fakeStore(record(undefined, "initial"));
    const exportResults = vi.fn(
      async (): Promise<ScorecardExport> =>
        ({ status: "succeeded", sink: "mlflow", exportedAt: now() }) as ScorecardExport,
    );

    // Publisher A drains the operation it holds — the INITIAL one.
    await drainPublicationOperation(
      { store, exportResults, operations },
      record(undefined, "initial"),
      initial,
      results("initial"),
      "publisher-a",
      now,
    );

    // …and the re-score's debt is untouched. A completes what it claimed, and nothing else.
    const after = await operations.listForScorecard(SCORECARD_ID);
    expect(after.find((o) => o.id === initial.id)?.state).toBe("published");
    expect(after.find((o) => o.id === rescore.id)?.state, "a stale publisher marked a newer settlement published").toBe(
      "pending",
    );
  });
});

// RED as of 186f9fd9: `expected "spy" to be called 1 times, but got 2` — both drains exported before either CAS.
describe("[R53 WAVE-C COUNTEREXAMPLE #16 — CLOSED] two concurrent drains produce one external effect", () => {
  it("the inline drain and the sweep do not both call the sink", async () => {
    const operations = new InMemoryPublicationOperationStore();
    const operation = planPublicationOperation({
      scorecardId: SCORECARD_ID,
      bundle: bundle("initial"),
      staged: exportOnly() as never,
      passId: "initial-abc",
      scoringRevision: 1,
      exports: true,
      results: results("initial"),
      now: now(),
    });
    if (!operation) throw new Error("this settlement owes an export");
    await operations.open(operation);

    const { store } = fakeStore(record(undefined, "initial"));
    const exportResults = vi.fn(
      async (): Promise<ScorecardExport> =>
        ({ status: "succeeded", sink: "mlflow", exportedAt: now() }) as ScorecardExport,
    );
    const held = record(undefined, "initial");

    // Both publishers go for the same operation — the winner's inline drain and the reconciler's sweep, the
    // pair Wave 4 documents as expected to overlap. The CLAIM is taken before any effect runs, so the loser
    // never reaches the sink at all.
    await Promise.all([
      drainPublicationOperation({ store, exportResults, operations }, held, operation, results("initial"), "a", now),
      drainPublicationOperation({ store, exportResults, operations }, held, operation, results("initial"), "b", now),
    ]);

    expect(exportResults, "both publishers created traces in the tenant's platform").toHaveBeenCalledTimes(1);
  });
});

// RED as of 186f9fd9: the exporter was never handed the key, so the sink could not dedupe the at-least-once call.
describe("[R53 WAVE-C COUNTEREXAMPLE #17 — CLOSED] the idempotency key reaches the sink", () => {
  it("passes the planned idempotency key to the exporter", async () => {
    const operations = new InMemoryPublicationOperationStore();
    const operation = planPublicationOperation({
      scorecardId: SCORECARD_ID,
      bundle: bundle("initial"),
      staged: exportOnly() as never,
      passId: "initial-abc",
      scoringRevision: 1,
      exports: true,
      results: results("initial"),
      now: now(),
    });
    if (!operation) throw new Error("this settlement owes an export");
    expect(operation.effects.find((e) => e.kind === "export")?.idempotencyKey).toBe(`${SCORECARD_ID}:initial-abc`);
    await operations.open(operation);

    const { store } = fakeStore(record(undefined, "initial"));
    const seen: unknown[] = [];
    const exportResults = vi.fn(async (_tenant: string, ctx: unknown): Promise<ScorecardExport> => {
      seen.push(ctx);
      return { status: "succeeded", sink: "mlflow", exportedAt: now() } as ScorecardExport;
    });

    await drainPublicationOperation(
      { store, exportResults, operations },
      record(undefined, "initial"),
      operation,
      results("initial"),
      "publisher",
      now,
    );

    expect(
      (seen[0] as { idempotencyKey?: string } | undefined)?.idempotencyKey,
      "the exporter cannot dedupe: the planned key never reaches it",
    ).toBe(`${SCORECARD_ID}:initial-abc`);
  });
});
