import type { CaseResult, PublicationPlan, ScorecardExport, ScorecardRecord } from "@everdict/contracts";
import { contentDigest } from "@everdict/domain";
import { describe, expect, it, vi } from "vitest";
import type { ScorecardStore, ScorecardUpdateGuard } from "../ports/scorecard-store.js";
import { drainPublication, planPublication } from "./publication.js";
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
// `publication` field, and the first settlement's owed export is gone from the record entirely.
describe.skip("[R53 WAVE-C COUNTEREXAMPLE #14] a re-score does not erase the previous settlement's debt", () => {
  it("keeps one owed operation per settlement", async () => {
    const p1 = planPublication({
      scorecardId: SCORECARD_ID,
      bundle: bundle("initial"),
      staged: stagedOf("initial") as never,
      passId: "initial-abc",
      exports: true,
      results: results("initial"),
      now: now(),
    });
    const p2 = planPublication({
      scorecardId: SCORECARD_ID,
      bundle: bundle("rescore"),
      staged: stagedOf("rescore") as never,
      passId: "rescore-def",
      exports: true,
      results: results("rescore"),
      now: now(),
    });
    expect(p1).toBeDefined();
    expect(p2).toBeDefined();

    const { store, current } = fakeStore(record(p1, "initial"));
    // The re-score settles while the initial publication is still owed — the ordinary case, because the
    // inline drain happens after the commit and a re-score can land in that window.
    await store.update(SCORECARD_ID, { publication: p2 }, undefined, undefined);

    // Both debts must still be findable. Today the row holds one field, so the initial pass's export — the
    // one an operator would be asked about when the traces never appeared — is unrecoverable.
    const held = current() as ScorecardRecord & { publications?: unknown[] };
    const owedForInitialPass = held.publications?.find((op) => (op as { passId?: string }).passId === "initial-abc");
    expect(
      owedForInitialPass,
      "the initial settlement's publication debt was overwritten by the re-score",
    ).toBeDefined();
  });
});

// RED as of 186f9fd9: `expected 'rescore-def' to be …` — publisher A's receipt lands on the row and the
// re-score's plan is gone, because the CAS only asked whether SOMETHING was pending.
describe.skip("[R53 WAVE-C COUNTEREXAMPLE #15] a publisher completes the plan it read, not whatever is pending", () => {
  it("a stale publisher cannot write its receipt over a newer settlement's plan", async () => {
    const p1 = planPublication({
      scorecardId: SCORECARD_ID,
      bundle: bundle("initial"),
      staged: exportOnly() as never,
      passId: "initial-abc",
      exports: true,
      results: results("initial"),
      now: now(),
    }) as PublicationPlan;
    const p2 = planPublication({
      scorecardId: SCORECARD_ID,
      bundle: bundle("initial"),
      staged: exportOnly() as never,
      passId: "rescore-def",
      exports: true,
      // Same results, so the payload-digest guard does not mask the race this test is about.
      results: results("initial"),
      now: now(),
    }) as PublicationPlan;

    const held = record(p1, "initial");
    const { store, current } = fakeStore(held);
    const exportResults = vi.fn(
      async (): Promise<ScorecardExport> =>
        ({ status: "succeeded", sink: "mlflow", exportedAt: "2026-08-17T01:00:00.000Z" }) as ScorecardExport,
    );

    // Publisher A read the record while P1 was pending…
    const asRead = current();
    // …the re-score settled in between…
    await store.update(SCORECARD_ID, { publication: p2 }, undefined, undefined);
    // …and A now drains the plan it is holding.
    await drainPublication({ store, exportResults }, asRead, results("initial"), now);

    // The row must still owe the re-score's publication. A must have learned it lost.
    expect(
      (current().publication as PublicationPlan & { passId?: string })?.state,
      "a stale publisher marked a newer settlement published",
    ).toBe("pending");
  });
});

// RED as of 186f9fd9: `expected "spy" to be called once, but got 2` — both drains export before either CAS.
describe.skip("[R53 WAVE-C COUNTEREXAMPLE #16] two concurrent drains produce one external effect", () => {
  it("the inline drain and the sweep do not both call the sink", async () => {
    const plan = planPublication({
      scorecardId: SCORECARD_ID,
      bundle: bundle("initial"),
      staged: exportOnly() as never,
      passId: "initial-abc",
      exports: true,
      results: results("initial"),
      now: now(),
    }) as PublicationPlan;

    const { store } = fakeStore(record(plan, "initial"));
    const exportResults = vi.fn(
      async (): Promise<ScorecardExport> =>
        ({ status: "succeeded", sink: "mlflow", exportedAt: "2026-08-17T01:00:00.000Z" }) as ScorecardExport,
    );
    const held = await store.get(SCORECARD_ID);
    if (!held) throw new Error("unreachable");

    // Both publishers read the same pending plan — the winner's inline drain and the reconciler's sweep,
    // which is the pair Wave 4 documents as expected to overlap.
    await Promise.all([
      drainPublication({ store, exportResults }, held, results("initial"), now),
      drainPublication({ store, exportResults }, held, results("initial"), now),
    ]);

    expect(exportResults, "both publishers created traces in the tenant's platform").toHaveBeenCalledTimes(1);
  });
});

// RED as of 186f9fd9: the exporter is never handed the key, so the sink cannot dedupe the at-least-once call.
describe.skip("[R53 WAVE-C COUNTEREXAMPLE #17] the idempotency key reaches the sink", () => {
  it("passes the planned idempotency key to the exporter", async () => {
    const plan = planPublication({
      scorecardId: SCORECARD_ID,
      bundle: bundle("initial"),
      staged: exportOnly() as never,
      passId: "initial-abc",
      exports: true,
      results: results("initial"),
      now: now(),
    }) as PublicationPlan;
    expect(plan.exports?.[0]?.idempotencyKey).toBe(`${SCORECARD_ID}:initial-abc`);

    const { store } = fakeStore(record(plan, "initial"));
    const seen: unknown[] = [];
    const exportResults = vi.fn(async (_tenant: string, ctx: unknown): Promise<ScorecardExport> => {
      seen.push(ctx);
      return { status: "succeeded", sink: "mlflow", exportedAt: "2026-08-17T01:00:00.000Z" } as ScorecardExport;
    });
    const held = await store.get(SCORECARD_ID);
    if (!held) throw new Error("unreachable");

    await drainPublication({ store, exportResults }, held, results("initial"), now);

    expect(
      (seen[0] as { idempotencyKey?: string } | undefined)?.idempotencyKey,
      "the exporter cannot dedupe: the planned key never reaches it",
    ).toBe(`${SCORECARD_ID}:initial-abc`);
  });
});

// Kept so a refactor that drops the digest guard cannot make the counterexamples above vacuous.
export const _payloadDigestOf = (r: CaseResult[]): string => contentDigest(r);
