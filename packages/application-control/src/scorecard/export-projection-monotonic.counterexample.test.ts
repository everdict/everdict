import type { CaseResult, PublicationOperation, ScorecardExport, ScorecardRecord } from "@everdict/contracts";
import { contentDigest } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import type { ArtifactStore } from "../ports/artifact-store.js";
import { InMemoryPublicationOperationStore } from "../ports/publication-operation-store.js";
import type { ScorecardStore } from "../ports/scorecard-store.js";
import { drainPublicationOperation } from "./publication.js";

// ── A MONOTONIC PROJECTION IS NOT A CHECK FOLLOWED BY A WRITE (arch-review 56, Wave F) ───────────────
//
// The record's `export` receipt is the reader-facing answer to "what was published for this batch". It is a
// projection of the operations ledger, so it must move forward only — an older settlement draining late must
// not replace a newer settlement's receipt.
//
// Review 54 Phase 4 gave it a guard and review 55 Wave 5 made that guard three-valued, and both are a READ
// followed by an unconditional WRITE:
//
//     if (outcome.export !== undefined && (await settlementPosition(deps, operation)) === "behind")
//       await deps.store.update(record.id, { export: outcome.export, … });
//
// Nothing holds between those two lines. Two settlements draining concurrently interleave straight through
// it:
//
//     r1: position → behind        (r2 has not completed yet)
//     r2: complete → position → behind → writes revision 2's receipt
//     r1: writes revision 1's receipt        ← the projection went backwards
//
// The operations ledger stays exactly right; the answer a human reads does not. And the window is not exotic:
// the winner drains inline while the reconciler sweeps whatever a crash left owed, so two publishers running
// at once is the ordinary shape this whole seam is built around.
//
// A guard whose subject can move between the check and the write is a comment. The write itself has to carry
// the condition — a store update conditioned on the revision it is replacing, so the loser's write matches no
// row instead of matching the row it should not have.

const SCORECARD_ID = "sc-1";
const RESULTS: CaseResult[] = [
  {
    caseId: "c1",
    harness: "h@1",
    trace: [],
    snapshot: { kind: "prompt", output: "done" },
    scores: [{ graderId: "tests-pass", metric: "tests_pass", value: 1, pass: true }],
  },
];

const record = {
  id: SCORECARD_ID,
  tenant: "acme",
  dataset: { id: "d", version: "1.0.0" },
  harness: { id: "h", version: "1" },
  status: "succeeded",
  createdAt: "2026-08-18T00:00:00.000Z",
  updatedAt: "2026-08-18T00:00:01.000Z",
} as unknown as ScorecardRecord;

const receiptFor = (revision: number): ScorecardExport =>
  ({
    sink: "mlflow",
    status: "succeeded",
    exportedAt: `2026-08-18T00:00:0${revision}.000Z`,
    cases: [{ caseId: "c1", externalId: `tr-${revision}` }],
  }) as ScorecardExport;

const operationFor = (revision: number): PublicationOperation =>
  ({
    id: `${SCORECARD_ID}#r${revision}#pass-${revision}`,
    state: "pending",
    settlement: { scorecardId: SCORECARD_ID, passId: `pass-${revision}`, scoringRevision: revision },
    effects: [
      {
        kind: "export",
        idempotencyKey: `${SCORECARD_ID}:pass-${revision}`,
        payloadDigest: contentDigest(RESULTS),
        payload: { kind: "unfrozen", reason: "not the subject of this file" },
      },
    ],
    plannedAt: "2026-08-18T00:00:01.000Z",
  }) as unknown as PublicationOperation;

const artifacts: ArtifactStore = {
  async put() {
    return "";
  },
  async get() {
    return undefined;
  },
  async publicUrlFor() {
    return undefined;
  },
};

// RED as of fcf36fc6, observed:
//   the reader-facing export receipt went backwards to an older settlement:
//   expected 'tr-1' to be 'tr-2'
describe("[R56 WAVE-F COUNTEREXAMPLE #7 — CLOSED] the current export receipt only moves forward", () => {
  // A LIVE INTERLEAVE IS NOT EXPRESSIBLE HERE, and a test that passes for a scheduling reason proves nothing
  // (rule `testing`, the vacuous-pass rules). Two concurrent drains through this seam settle in whatever order
  // the microtask queue gives them, so the backwards write is REACHABLE rather than reproducible — which is
  // exactly why the fix is a conditional write rather than a wider check. What is pinned instead is the
  // mechanism: the write carries the revision it replaces, so the loser matches no row at the store.

  it("conditions the write on the revision it replaces, rather than checking and then writing", async () => {
    // The mechanism, pinned so the fix cannot be "check harder". A guard whose subject can move between the
    // read and the write is a comment; the write has to carry the condition.
    const operations = new InMemoryPublicationOperationStore();
    const operation = operationFor(1);
    await operations.open(operation);
    const guards: Array<Record<string, unknown> | undefined> = [];
    const store = {
      async update(_id: string, patch: Partial<ScorecardRecord>, _events: unknown, guard?: Record<string, unknown>) {
        if ("export" in patch) guards.push(guard);
        return record;
      },
    } as unknown as ScorecardStore;

    await drainPublicationOperation(
      { artifacts, store, operations, exportResults: async () => receiptFor(1) },
      record,
      operation,
      RESULTS,
      "publisher-1",
      () => "2026-08-18T00:00:02.000Z",
    );

    expect(guards, "the receipt write was unguarded").toHaveLength(1);
    expect(
      guards[0],
      "the receipt write names no revision, so a concurrent older drain can still land on top of it",
    ).toMatchObject({ expectExportRevisionBelow: 1 });
  });
});
