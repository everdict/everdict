import type { CaseResult, ScorecardExport, ScorecardRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryPublicationOperationStore } from "../ports/publication-operation-store.js";
import type { ScorecardStore } from "../ports/scorecard-store.js";
import { drainPublicationOperation, planPublicationOperation } from "./publication.js";
import type { AnalysisBundle } from "./scorecard-observability.js";

// ── A SETTLEMENT OWNS ITS BYTES (arch-review 54, Phase 4) ────────────────────────────────────────────
//
// Wave C gave each settlement its own operation, keyed `(scorecardId, scoringRevision, passId)` and claimed by
// that exact id. The CARDINALITY is right now. What the operation carries is not: for the export effect it
// stores a `payloadDigest` and no bytes, and the reconciler re-hydrates the record to get them —
//
//     // The HYDRATING read: a settled batch stores its results on the child runs, and the export payload is
//     // those results. Re-read rather than remembered, because the process that planned this is gone.
//
// — then refuses PERMANENTLY if what it read does not digest to what was planned:
//
//     if (contentDigest(results) !== effect.payloadDigest) {
//       fail("the record's results are no longer the ones this settlement counted — not exported", true);
//
// Refusing to export the NEW bytes under the OLD settlement's receipt is correct. Concluding that the old
// settlement's export can therefore never happen is not. The bytes it owes existed; nobody froze them. So the
// ordinary sequence — settle revision 1, crash before the drain, re-score to revision 2 — closes revision 1's
// export as `unverifiable` forever, and the tenant's observability platform never receives a batch that ran,
// was judged, and was recorded as exported-pending.
//
// The artifact half of the same function already does it right: it reads an immutable staged object by key and
// verifies its digest before promoting. Only the export half reaches for live state.
//
// Second, the promotion target. `artifacts.put(effect.key, …)` and the `record.export` projection are both
// written with no revision guard, under a comment that is true per operation and false across them —
// "only one publisher can reach this line for one operation". Two operations are two publishers, and they
// finish in whatever order their retries land in, so a late revision-1 drain moves `analyses/<id>.json` and the
// record's export receipt BACKWARDS over revision 2's.
//
// The invariant: an operation references frozen bytes by key+digest, and `current` moves forward only. See
// rule `protocol` L4.

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

function record(marker: string): ScorecardRecord {
  return {
    id: SCORECARD_ID,
    tenant: "acme",
    dataset: { id: "d", version: "1.0.0" },
    harness: { id: "h", version: "1" },
    status: "succeeded",
    scorecard: { suiteId: "d", harness: "h@1", results: results(marker) },
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:01.000Z",
  } as unknown as ScorecardRecord;
}

function fakeStore(initial: ScorecardRecord): { store: ScorecardStore; current: () => ScorecardRecord } {
  let held = initial;
  const store = {
    async update(id: string, patch: Partial<ScorecardRecord>) {
      if (id !== held.id) return undefined;
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

const exportOnly = () => ({ key: `analyses/${SCORECARD_ID}/x.json` });
const now = () => "2026-08-18T01:00:00.000Z";

const EXPORT_OK: ScorecardExport = {
  status: "succeeded",
  sink: "mlflow",
  exportedAt: "2026-08-18T01:00:00.000Z",
};

const planFor = (marker: string, revision: number, passId: string) =>
  planPublicationOperation({
    scorecardId: SCORECARD_ID,
    bundle: bundle(marker),
    staged: exportOnly() as never,
    passId,
    scoringRevision: revision,
    exports: true,
    results: results(marker),
    now: now(),
  } as never);

// RED as of efe3657e, observed: `expected 'owed' to be 'published'` — and the operation is closed permanently,
// so no sweep ever retries it.
describe.skip("[R54 PHASE-4 COUNTEREXAMPLE #12] a re-score does not make the previous settlement's export impossible", () => {
  it("exports the bytes THAT settlement counted, not the record's current ones", async () => {
    const operations = new InMemoryPublicationOperationStore();
    const first = planFor("revision-1", 1, "pass-1");
    if (!first) throw new Error("the fixture must produce an operation");
    await operations.open(first);

    // …the process died before the drain, and a re-score replaced the plane in the meantime.
    const { store } = fakeStore(record("revision-2"));
    const exported: CaseResult[][] = [];

    const outcome = await drainPublicationOperation(
      {
        store,
        operations,
        exportResults: async (_tenant: string, _ctx: unknown, payload: CaseResult[]): Promise<ScorecardExport> => {
          exported.push(payload);
          return EXPORT_OK;
        },
      } as never,
      record("revision-2"),
      first,
      results("revision-2"), // what the reconciler re-hydrated — deliberately NOT what the operation owes
      "publisher-1",
      now,
    );

    expect(outcome.kind, "the settlement's own export was closed as impossible by an unrelated re-score").toBe(
      "published",
    );
    // And it must have shipped revision 1's bytes — exporting revision 2's under revision 1's receipt is the
    // substitution the digest check was defending against, and that defence stays.
    expect(exported[0]?.[0]?.snapshot).toMatchObject({ output: "revision-1" });
  });
});

// RED as of efe3657e, observed: `expected 1 to be 2` — the older operation's receipt overwrote the newer one.
describe.skip("[R54 PHASE-4 COUNTEREXAMPLE #13] a late operation cannot move `current` backwards", () => {
  it("keeps the newest settlement's export receipt when an older drain lands after it", async () => {
    const operations = new InMemoryPublicationOperationStore();
    const older = planFor("revision-1", 1, "pass-1");
    const newer = planFor("revision-2", 2, "pass-2");
    if (!older || !newer) throw new Error("the fixture must produce both operations");
    await operations.open(older);
    await operations.open(newer);

    const { store, current } = fakeStore(record("revision-2"));
    const deps = (revision: number) =>
      ({
        store,
        operations,
        exportResults: async (): Promise<ScorecardExport> =>
          ({ ...EXPORT_OK, scoringRevision: revision }) as unknown as ScorecardExport,
      }) as never;

    // The newer settlement publishes first (its process was alive); the older one's sweep lands afterwards.
    await drainPublicationOperation(deps(2), record("revision-2"), newer, results("revision-2"), "pub-2", now);
    await drainPublicationOperation(deps(1), record("revision-1"), older, results("revision-1"), "pub-1", now);

    expect(
      (current().export as { scoringRevision?: number } | undefined)?.scoringRevision,
      "a revision-1 drain that finished late replaced revision-2's export receipt",
    ).toBe(2);
  });
});
