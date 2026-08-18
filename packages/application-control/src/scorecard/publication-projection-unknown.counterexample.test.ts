import type { CaseResult, PublicationOperation, ScorecardExport, ScorecardRecord } from "@everdict/contracts";
import { contentDigest } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import type { ArtifactStore } from "../ports/artifact-store.js";
import { InMemoryPublicationOperationStore } from "../ports/publication-operation-store.js";
import type { ScorecardStore } from "../ports/scorecard-store.js";
import { drainPublicationOperation } from "./publication.js";

// ── A PROJECTION THAT CANNOT BE READ IS NOT A PROJECTION THAT IS AHEAD (arch-review 55, Wave 5) ──────
//
// Phase 4 made the record's publication projection monotonic by reading its position from the operations
// LEDGER (which settlement published) rather than from the projection itself. `settlementPosition` answers
// it — and it used to answer in TWO values:
//
//     const siblings = await deps.operations.listForScorecard(...).catch(() => undefined);
//     if (siblings === undefined) return true;   // "a newer settlement is already there"
//
// "The ledger could not be read" folded into "somebody newer is ahead of me". Wave 5 named the third case;
// Wave 7 then deleted the effect that made the fold a wrong DECISION (the write-only alias promotion), so
// what this file pins is what remains and is still live: the EXPORT RECEIPT projection on the record.
//
// It is a projection, not a fence — the operation is already `complete` by the time it is written. That is
// exactly why the third case still has to be named: `ahead` means "a newer receipt is already on the record,
// leave it", and `unknown` means "we never established the order". Folding the second into the first makes a
// ledger blip indistinguishable from a settled fact, and the next person to add a consumer here reads the
// skip as agreement.
//
// A DEGRADED read — the third case rule `testing` singles out, because it produces a wrong belief rather
// than a visible error.

const SCORECARD_ID = "sc-1";
const PAYLOAD_KEY = "payloads/sc-1/pass-1.json";
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

const RECEIPT: ScorecardExport = {
  sink: "mlflow",
  status: "succeeded",
  exportedAt: "2026-08-18T00:00:02.000Z",
  cases: [{ caseId: "c1", externalId: "tr-1" }],
};

const operation: PublicationOperation = {
  id: `pub:${SCORECARD_ID}:pass-1:1`,
  state: "pending",
  settlement: { scorecardId: SCORECARD_ID, passId: "pass-1", scoringRevision: 1 },
  // The digest is computed by the same function the production planner uses, over the exact bytes frozen
  // below — so the payload passes its own guard and the ONLY thing under test is the ledger read.
  effects: [
    {
      kind: "export",
      idempotencyKey: `${SCORECARD_ID}:pass-1`,
      payloadDigest: contentDigest(RESULTS),
      payloadKey: PAYLOAD_KEY,
    },
  ],
  plannedAt: "2026-08-18T00:00:01.000Z",
} as unknown as PublicationOperation;

// A world whose artifact store holds the frozen payload, whose sink accepts the export, and whose operations
// LEDGER is down — what a Postgres blip produces, and the only world in which "ahead" and "unknown" differ.
async function drainAgainstAnUnreadableLedger(): Promise<{
  outcome: Awaited<ReturnType<typeof drainPublicationOperation>>;
  exported: number;
  projected: Array<ScorecardExport | undefined>;
}> {
  const objects = new Map<string, Buffer>([[PAYLOAD_KEY, Buffer.from(JSON.stringify(RESULTS))]]);
  const projected: Array<ScorecardExport | undefined> = [];
  let exported = 0;

  const artifacts: ArtifactStore = {
    async put(key, body) {
      objects.set(key, Buffer.from(body));
      return `https://artifacts.invalid/${key}`;
    },
    async get(key) {
      return objects.get(key);
    },
    async publicUrlFor() {
      return undefined;
    },
  };

  const operations = new InMemoryPublicationOperationStore();
  await operations.open(operation);
  // The ledger goes down AFTER the row exists and AFTER the claim: a publisher that could not claim never
  // reaches the projection, so the interesting world is the one where the effect ran and the ORDER is unknown.
  const listForScorecard = operations.listForScorecard.bind(operations);
  void listForScorecard;
  operations.listForScorecard = async (): Promise<PublicationOperation[]> => {
    throw new Error("operations ledger unreachable");
  };

  const store = {
    async update(_id: string, patch: Partial<ScorecardRecord>) {
      if ("export" in patch) projected.push(patch.export);
      return record;
    },
  } as unknown as ScorecardStore;

  const outcome = await drainPublicationOperation(
    {
      artifacts,
      store,
      operations,
      exportResults: async (): Promise<ScorecardExport> => {
        exported += 1;
        return RECEIPT;
      },
    },
    record,
    operation,
    RESULTS,
    "publisher-1",
    () => "2026-08-18T00:00:02.000Z",
  );
  return { outcome, exported, projected };
}

// RED as of 4a8b02b6 in its original form (`expected { kind: 'published' } to have property 'reason'`), on the
// alias effect this seam no longer has. Re-pointed at the projection that survived the Wave 7 deletion.
describe("[R55 WAVE-5 COUNTEREXAMPLE #5 — CLOSED] a drain that could not read the settlement order", () => {
  it("performs the owed export — an unreadable ledger is not a reason to withhold the effect", async () => {
    // The claim already established this publisher's right to act. What it cannot establish afterwards is
    // where its receipt belongs, and that must not be confused with whether the work was owed.
    const { outcome, exported } = await drainAgainstAnUnreadableLedger();
    expect(exported, "the export the settlement owed did not happen").toBe(1);
    expect(outcome.kind).toBe("published");
  });

  it("does not move the record's export receipt on an order it never established", async () => {
    // `ahead` and `unknown` both leave the projection alone, and only `ahead` is a fact. Writing here on
    // `unknown` is the backwards write the guard exists to prevent; the receipt stays where the last drain
    // that COULD read the ledger put it.
    const { projected } = await drainAgainstAnUnreadableLedger();
    expect(
      projected,
      "the drain overwrote the record's export receipt without knowing whether a newer settlement is already there",
    ).toEqual([]);
  });
});
