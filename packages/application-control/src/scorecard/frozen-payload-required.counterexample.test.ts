import type { CaseResult, ScorecardExport, ScorecardRecord } from "@everdict/contracts";
import { contentDigest } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import type { ArtifactStore } from "../ports/artifact-store.js";
import { InMemoryPublicationOperationStore } from "../ports/publication-operation-store.js";
import type { ScorecardStore } from "../ports/scorecard-store.js";
import { drainPublicationOperation, planPublicationOperation } from "./publication.js";
import { type AnalysisBundle, stageAnalysis } from "./scorecard-observability.js";

// ── A SETTLEMENT SAYS WHERE ITS BYTES ARE, OR WHY IT CANNOT (arch-review 55, Wave 9) ─────────────────
//
// L4: a settlement stages its payload as an immutable object and the operation carries the KEY. Phase 4 built
// that and left the field OPTIONAL, with the absent case documented as the legacy shape:
//
//     // Optional for the operations mig 0188 backfilled from the pre-Phase-4 field: they carry a digest and
//     // no key, and the drain treats them exactly as before (re-read, compare, refuse on mismatch).
//     payloadKey: z.string().min(1).optional(),
//
// It is not only the legacy shape. `stageAnalysis` freezes the payload BEST-EFFORT:
//
//     try { ...put(exportPayloadKey(id, passId), ...); out.payloadKey = key; }
//     catch { /* best-effort — the plan then carries a digest and no key */ }
//
// So a live settlement whose object store blipped for one PUT produces an operation that is byte-identical
// to a row migrated from 2026-05, and the drain silently takes the weaker path for both: re-read the record's
// current results, compare, refuse on mismatch. That refusal is fail-CLOSED and correct as far as it goes —
// and it can never converge once anything re-scores the batch, because the bytes it owed were never frozen
// and the plane it would compare against has moved for good.
//
// The absent field is doing two incompatible jobs at once, which is what makes it an escape hatch rather than
// a legacy allowance:
//   · "this operation predates payload freezing" — a statement about our history;
//   · "this settlement tried to freeze its bytes and failed" — a statement about THIS batch, which is an
//     incident, and which is currently indistinguishable from the first.
//
// Neither the record nor the operator can tell them apart, and nothing says WHY. The rule this repo already
// wrote for exactly this shape (rule `suite`): absence is not a legacy allowance — a state that must be
// weaker says so, and says why. So the optional goes away and the weaker case becomes a named one carrying
// its reason, in the same union the drain switches on.

const SCORECARD_ID = "sc-1";
const PASS_ID = "pass-1";

const RESULTS: CaseResult[] = [
  {
    caseId: "c1",
    harness: "h@1",
    trace: [],
    snapshot: { kind: "prompt", output: "done" },
    scores: [{ graderId: "tests-pass", metric: "tests_pass", value: 1, pass: true }],
  },
];

const bundle = { summary: "b" } as unknown as AnalysisBundle;

const record = {
  id: SCORECARD_ID,
  tenant: "acme",
  dataset: { id: "d", version: "1.0.0" },
  harness: { id: "h", version: "1" },
  status: "succeeded",
  createdAt: "2026-08-18T00:00:00.000Z",
  updatedAt: "2026-08-18T00:00:01.000Z",
} as unknown as ScorecardRecord;

const store = {
  async update() {
    return record;
  },
} as unknown as ScorecardStore;

const brokenStore: ArtifactStore = {
  async put() {
    throw new Error("s3 down");
  },
  async get() {
    return undefined;
  },
  async publicUrlFor() {
    return undefined;
  },
};

// RED as of 9155f0e6, observed:
//   a settlement that could not freeze its bytes produced an operation indistinguishable from a legacy one:
//   expected undefined to be truthy
describe("[R55 WAVE-9 COUNTEREXAMPLE #7 — CLOSED] an export effect states where its bytes are", () => {
  it("says the payload could not be frozen, and WHY, instead of omitting the field", async () => {
    // Given a settle whose object store refuses the payload put — one blip, not a broken deployment.
    const staged = await stageAnalysis({ artifacts: brokenStore }, SCORECARD_ID, bundle, PASS_ID, RESULTS);

    expect(
      staged.payload,
      "a settlement that could not freeze its bytes produced an operation indistinguishable from a legacy one",
    ).toBeTruthy();
    expect(staged.payload?.kind).toBe("unfrozen");
    if (staged.payload?.kind !== "unfrozen") throw new Error("expected an unfrozen payload");
    expect(staged.payload.reason, "the incident was recorded as an absence").toMatch(/s3 down/);
  });

  it("carries the frozen key when the freeze succeeded — the ordinary path is unchanged", async () => {
    const objects = new Map<string, Buffer>();
    const working: ArtifactStore = {
      async put(key, bytes) {
        objects.set(key, Buffer.from(bytes));
        return `memory://${key}`;
      },
      async get(key) {
        return objects.get(key);
      },
      async publicUrlFor() {
        return undefined;
      },
    };
    const staged = await stageAnalysis({ artifacts: working }, SCORECARD_ID, bundle, PASS_ID, RESULTS);
    expect(staged.payload?.kind).toBe("frozen");
    if (staged.payload?.kind !== "frozen") throw new Error("expected a frozen payload");
    expect(objects.has(staged.payload.key)).toBe(true);
  });

  it("REFUSES to plan an export for a settlement that never asked where its bytes would go", () => {
    // The compiler cannot ask this one — `staged` is a bag, and a caller that owes an export and skipped the
    // freeze is a caller that has not answered the question at all. That is a bug in this system, not a
    // weaker state of the world, so it is refused rather than defaulted to `unfrozen`: defaulting would put
    // the escape hatch back one layer down, wearing a name.
    expect(() =>
      planPublicationOperation({
        scorecardId: SCORECARD_ID,
        bundle,
        staged: {},
        passId: PASS_ID,
        exports: true,
        results: RESULTS,
        scoringRevision: 1,
        now: "2026-08-18T00:00:00.000Z",
      }),
    ).toThrow(/owes an export/);
  });

  it("a drain on an unfrozen payload refuses with the reason the freeze failed, not just a mismatch", async () => {
    // The behaviour is deliberately UNCHANGED — compare the live plane, refuse on mismatch. What changes is
    // what the operator reads: "these are not the bytes this settlement counted" said nothing about why the
    // bytes could not be produced, so an incident during the settle looked like an ordinary re-score.
    const operation = planPublicationOperation({
      scorecardId: SCORECARD_ID,
      bundle,
      staged: { payload: { kind: "unfrozen", reason: "s3 down" } },
      passId: PASS_ID,
      exports: true,
      results: RESULTS,
      scoringRevision: 1,
      now: "2026-08-18T00:00:00.000Z",
    });
    if (!operation) throw new Error("this settlement owes an export");
    const operations = new InMemoryPublicationOperationStore();
    await operations.open(operation);
    const exports: string[] = [];

    const outcome = await drainPublicationOperation(
      {
        store,
        operations,
        exportResults: async (): Promise<ScorecardExport> => {
          exports.push(SCORECARD_ID);
          return { status: "succeeded", sink: "mlflow", exportedAt: "t" } as ScorecardExport;
        },
      },
      record,
      operation,
      // A re-score landed: the live plane is no longer the one this settlement counted.
      [{ ...RESULTS[0], scores: [] } as CaseResult],
      "publisher-1",
      () => "2026-08-18T00:00:02.000Z",
    );

    expect(exports, "the newer bytes were shipped under the older settlement's receipt").toEqual([]);
    if (outcome.kind !== "owed") throw new Error(`expected an owed outcome, got ${outcome.kind}`);
    expect(outcome.reason, "the drain reported a mismatch without saying the bytes were never frozen").toMatch(
      /s3 down/,
    );
    // …and it is closed rather than swept forever: nothing can produce bytes that were never frozen.
    expect((await operations.listForScorecard(SCORECARD_ID))[0]?.state).toBe("unverifiable");
  });

  it("still exports when the live plane IS the one the unfrozen settlement counted", async () => {
    // The convergent half, and the reason `unfrozen` is a state rather than a failure: the overwhelmingly
    // common case is that the inline drain runs milliseconds after the settle and nothing has moved.
    const operation = planPublicationOperation({
      scorecardId: SCORECARD_ID,
      bundle,
      staged: { payload: { kind: "unfrozen", reason: "s3 down" } },
      passId: PASS_ID,
      exports: true,
      results: RESULTS,
      scoringRevision: 1,
      now: "2026-08-18T00:00:00.000Z",
    });
    if (!operation) throw new Error("this settlement owes an export");
    const effect = operation.effects[0];
    if (effect?.kind !== "export") throw new Error("expected an export effect");
    expect(effect.payloadDigest).toBe(contentDigest(RESULTS));

    const operations = new InMemoryPublicationOperationStore();
    await operations.open(operation);
    const exports: string[] = [];
    const outcome = await drainPublicationOperation(
      {
        store,
        operations,
        exportResults: async (): Promise<ScorecardExport> => {
          exports.push(SCORECARD_ID);
          return { status: "succeeded", sink: "mlflow", exportedAt: "t" } as ScorecardExport;
        },
      },
      record,
      operation,
      RESULTS,
      "publisher-1",
      () => "2026-08-18T00:00:02.000Z",
    );
    expect(exports).toEqual([SCORECARD_ID]);
    expect(outcome.kind).toBe("published");
  });
});
