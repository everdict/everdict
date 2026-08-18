import type { PublicationOperation, ScorecardRecord } from "@everdict/contracts";
import { contentDigest } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import type { ArtifactStore } from "../ports/artifact-store.js";
import { InMemoryPublicationOperationStore } from "../ports/publication-operation-store.js";
import type { ScorecardStore } from "../ports/scorecard-store.js";
import { drainPublicationOperation } from "./publication.js";

// ── A PROJECTION THAT CANNOT BE READ IS NOT A PROJECTION THAT IS AHEAD (arch-review 55, Wave 5) ──────
//
// Phase 4 made the mutable `analyses/<id>.json` alias monotonic, and did it the right way: the position comes
// from the operations LEDGER (which settlement published) rather than from the object, so there is no second
// race and no sidecar. `aliasIsAhead` answers it — and answers it in TWO values:
//
//     const siblings = await deps.operations.listForScorecard(...).catch(() => undefined);
//     if (siblings === undefined) return true;
//
// "The ledger could not be read" is returned as "a newer settlement is already there". Its comment says that
// is the fail-closed side — "a projection moved on a guess is exactly the backwards write this exists to
// prevent, and the operation stays owed so a later sweep can decide with a readable ledger."
//
// It does not stay owed. The caller is a `continue` inside `performEffects` with no `fail(...)` beside it:
//
//     if (await aliasIsAhead(deps, operation)) continue;
//     await deps.artifacts.put(effect.key, …);
//
// Skipping is the right answer for "ahead" — the world is already where this operation wanted it, or better.
// It is the wrong answer for "unknown": nothing promoted the alias, nothing recorded that nothing did, and
// the loop falls out with `owed === undefined`, so the drain returns `published`, `complete`s the operation
// and removes it from the ledger. The analysis a human opens keeps describing whichever pass wrote the alias
// last — permanently, because the one row that would have fixed it certified itself done.
//
// L2 exactly (a fold over zero answers that certifies work is finished) and L5 exactly (completion is a
// read-back of zero; nothing here observed the promotion happen). Both halves have to move: the read becomes
// three-valued, and the consumer that was treating "unknown" as a state of the world names it instead.
//
// A DEGRADED read — the third case rule `testing` singles out, because it produces a wrong decision rather
// than a visible error.

const SCORECARD_ID = "sc-1";
const STAGED_KEY = "analyses/sc-1/pass-1.json";
const ALIAS_KEY = `analyses/${SCORECARD_ID}.json`;
const BUNDLE = { summary: "the bundle this settlement staged" };

const record = {
  id: SCORECARD_ID,
  tenant: "acme",
  dataset: { id: "d", version: "1.0.0" },
  harness: { id: "h", version: "1" },
  status: "succeeded",
  createdAt: "2026-08-18T00:00:00.000Z",
  updatedAt: "2026-08-18T00:00:01.000Z",
} as unknown as ScorecardRecord;

const operation: PublicationOperation = {
  id: `pub:${SCORECARD_ID}:pass-1:1`,
  state: "pending",
  settlement: { scorecardId: SCORECARD_ID, passId: "pass-1", scoringRevision: 1 },
  // The digest is computed by the same function the production planner uses, over the exact bytes staged
  // below — so the staged object passes its own guard and the ONLY thing between this drain and the
  // promotion is the ledger read under test.
  effects: [{ kind: "artifact", key: ALIAS_KEY, from: STAGED_KEY, digest: contentDigest(BUNDLE) }],
  plannedAt: "2026-08-18T00:00:01.000Z",
} as unknown as PublicationOperation;

// A world whose artifact store holds the staged object and whose operations LEDGER is down — what a Postgres
// blip produces, and the only world in which "ahead" and "unknown" differ.
async function drainAgainstAnUnreadableLedger(): Promise<{
  outcome: Awaited<ReturnType<typeof drainPublicationOperation>>;
  promoted: string[];
  stillOwed: number;
}> {
  const objects = new Map<string, Buffer>([[STAGED_KEY, Buffer.from(JSON.stringify(BUNDLE))]]);
  const promoted: string[] = [];

  const artifacts: ArtifactStore = {
    async put(key, body) {
      promoted.push(key);
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
  // The ledger goes down AFTER the row exists: a publisher that could not open its operation never reaches
  // the drain, so the interesting world is the one where the DEBT is durable and the POSITION is not.
  operations.listForScorecard = async (): Promise<PublicationOperation[]> => {
    throw new Error("operations ledger unreachable");
  };

  const store = {
    async update() {
      return record;
    },
  } as unknown as ScorecardStore;

  const outcome = await drainPublicationOperation(
    { artifacts, store, operations },
    record,
    operation,
    [],
    "publisher-1",
    () => "2026-08-18T00:00:02.000Z",
  );
  // The sweep's own question, asked of the real ledger: is this debt still there for someone to retry?
  const owed = await operations.listOwed(10, "2026-08-18T01:00:00.000Z");
  return { outcome, promoted, stillOwed: owed.length };
}

// RED as of 4a8b02b6, observed:
//   the drain certified a publication whose one effect it skipped because it could not find out anything:
//   expected { kind: 'published' } to have property 'reason'
describe("[R55 WAVE-5 COUNTEREXAMPLE #5 — CLOSED] a drain that could not read the projection's position", () => {
  it("does not certify publication over a promotion it never performed", async () => {
    const { outcome, promoted } = await drainAgainstAnUnreadableLedger();

    // Not promoting is CORRECT: moving a monotonic projection on a guess is the backwards write the guard
    // exists to prevent. The defect is everything that follows from it.
    expect(promoted, "the alias moved without knowing whether a newer settlement is already there").toEqual([]);
    expect(
      outcome,
      "the drain certified a publication whose one effect it skipped because it could not find out anything",
    ).toHaveProperty("reason");
    expect(outcome.kind).toBe("owed");
  });

  it("leaves the debt in the ledger, RETRYABLE — an unreadable ledger is transient, not a refusal", async () => {
    // The distinction `performEffects` already draws for its staged-object failures: a missing artifact is
    // permanent (no retry brings it back), an unreadable ledger is not. Recorded as permanent, the row is
    // released un-retryable and the observable outcome is the same as the bug — the alias never moves.
    const { outcome, stillOwed } = await drainAgainstAnUnreadableLedger();
    if (outcome.kind !== "owed") throw new Error(`expected an owed outcome, got ${outcome.kind}`);
    expect(outcome.reason).toMatch(/could not|unreachable|unknown/i);
    expect(stillOwed, "the operation left the sweep, so nothing will ever promote this settlement's alias").toBe(1);
  });
});
