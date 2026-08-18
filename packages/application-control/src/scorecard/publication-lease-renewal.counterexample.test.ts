import type { CaseResult, PublicationOperation, ScorecardExport, ScorecardRecord } from "@everdict/contracts";
import { contentDigest } from "@everdict/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryPublicationOperationStore } from "../ports/publication-operation-store.js";
import type { ScorecardStore } from "../ports/scorecard-store.js";
import { drainPublicationOperation } from "./publication.js";

// ── A LEASE HELD ACROSS AN EXTERNAL CALL IS RENEWED, OR IT IS NOT A FENCE (arch-review 55, Wave 8) ───
//
// L4's last unclosed clause. The drain claims the operation, performs its effects, and completes:
//
//     const claimed = await deps.operations.claim(operation.id, owner, leaseSeconds, now());
//     const outcome = await performEffects(deps, record, claimed, results);   // ← an HTTP call to the tenant's
//     const wrote   = await deps.operations.complete(operation.id, owner, now());   //   observability platform
//
// The lease is taken once and never touched again. `performEffects` is the export: a network call to MLflow,
// Langfuse or LangSmith with a whole batch's traces on it, which is exactly the effect that can outrun a
// lease sized for "a publisher's process died". The moment it does, the reconciler's `listOwed` sees a
// `claimed` row whose lease has expired — the ledger's own definition of an abandoned drain — and hands the
// operation to a second publisher WHILE the first is still uploading.
//
// The lease was doing the one job a lease has and the reason the row looked abandoned was that the work was
// taking a long time, which is the opposite of abandoned.
//
// Two consequences, in order of how much they cost:
//   · the tenant's platform receives the batch twice. The idempotency key means it CAN collapse them, which
//     is mitigation and not correctness — a sink that ignores the key duplicates every trace, and the
//     duplication is invisible from this side;
//   · the first publisher's `complete` is then refused (owner-guarded, correctly), so the drain that actually
//     did the work reports `skipped` and the receipt on the record belongs to the second one.
//
// The fix is the one L4 names: renew while the call runs. The heartbeat is the drain's, not the effect's —
// `performEffects` must not have to know it is being fenced, or every future effect has to remember to say so.
//
// A TIMING property, so the clock is faked: real sleeps here would make the suite slow AND flaky, and the
// thing under test is an ordering, not a duration.

const SCORECARD_ID = "sc-1";
const PAYLOAD_KEY = "payloads/sc-1/pass-1.json";
const LEASE_SECONDS = 60;

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
  id: `${SCORECARD_ID}#r1#pass-1`,
  state: "pending",
  settlement: { scorecardId: SCORECARD_ID, passId: "pass-1", scoringRevision: 1 },
  effects: [
    {
      kind: "export",
      idempotencyKey: `${SCORECARD_ID}:pass-1`,
      payloadDigest: contentDigest(RESULTS),
      payload: { kind: "frozen", key: PAYLOAD_KEY },
    },
  ],
  plannedAt: "2026-08-18T00:00:01.000Z",
} as unknown as PublicationOperation;

const store = {
  async update() {
    return record;
  },
} as unknown as ScorecardStore;

// A wall clock the test advances, shared by the drain's `now()` and the store's lease arithmetic — so
// "the lease expired" is a fact about the same timeline the heartbeat runs on.
function world() {
  let millis = Date.parse("2026-08-18T00:00:02.000Z");
  const now = (): string => new Date(millis).toISOString();
  const operations = new InMemoryPublicationOperationStore();
  const objects = new Map<string, Buffer>([[PAYLOAD_KEY, Buffer.from(JSON.stringify(RESULTS))]]);
  return {
    now,
    operations,
    advance: (seconds: number) => {
      millis += seconds * 1000;
    },
    artifacts: {
      async put() {
        return "";
      },
      async get(key: string) {
        return objects.get(key);
      },
      async publicUrlFor() {
        return undefined;
      },
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

// RED as of 76da226c, observed:
//   the reconciler could claim the operation while its export was still uploading:
//   expected [ { id: 'sc-1#r1#pass-1', …(5) } ] to have a length of 0 but got 1
describe("[R55 WAVE-8 COUNTEREXAMPLE #6 — CLOSED] a publication lease outlives the export it fences", () => {
  it("is renewed while the sink call is in flight, so the sweep never calls the drain abandoned", async () => {
    const w = world();
    await w.operations.open(operation);
    let owedMidFlight: PublicationOperation[] = [];

    const drain = drainPublicationOperation(
      {
        artifacts: w.artifacts,
        store,
        operations: w.operations,
        // The slow export. It holds the drain open past the lease, then asks the ledger the question the
        // reconciler asks: is this operation available to somebody else right now?
        exportResults: async (): Promise<ScorecardExport> => {
          // A long upload, advanced in STEPS — the injected clock and the timer wheel together, because a
          // single jump would let one beat renew the whole span and the test would pass over a heartbeat
          // that fired once and stopped. Six lease-lengths is the ordinary shape for a batch of several
          // hundred cases against a platform that rate-limits.
          for (let step = 0; step < 18; step += 1) {
            w.advance(LEASE_SECONDS / 3);
            await vi.advanceTimersByTimeAsync((LEASE_SECONDS / 3) * 1000);
          }
          owedMidFlight = await w.operations.listOwed(10, w.now());
          return RECEIPT;
        },
      },
      record,
      operation,
      RESULTS,
      "publisher-1",
      w.now,
      LEASE_SECONDS,
    );

    const outcome = await drain;

    expect(owedMidFlight, "the reconciler could claim the operation while its export was still uploading").toHaveLength(
      0,
    );
    // …and the publisher that did the work is the one that completes it.
    expect(outcome.kind).toBe("published");
    expect((await w.operations.listForScorecard(SCORECARD_ID))[0]?.state).toBe("published");
  });

  it("stops renewing once the drain is done — a finished publisher does not hold a row hostage", async () => {
    // The other half, and the reason a heartbeat needs a `finally`: a renewal loop that outlives its drain
    // keeps a completed operation looking claimed, and a FAILED one un-sweepable for as long as the process
    // lives. The observable form is that a released operation is immediately owed again.
    const w = world();
    await w.operations.open(operation);

    const outcome = await drainPublicationOperation(
      {
        artifacts: w.artifacts,
        store,
        operations: w.operations,
        exportResults: async (): Promise<ScorecardExport> => {
          throw new Error("sink 503");
        },
      },
      record,
      operation,
      RESULTS,
      "publisher-1",
      w.now,
      LEASE_SECONDS,
    );
    expect(outcome.kind).toBe("owed");

    // Long after the drain returned, no heartbeat is still moving this row's lease.
    w.advance(LEASE_SECONDS * 10);
    await vi.advanceTimersByTimeAsync(LEASE_SECONDS * 10 * 1000);
    expect(
      await w.operations.listOwed(10, w.now()),
      "a transient sink failure left the operation unavailable to the sweep",
    ).toHaveLength(1);
  });
});
