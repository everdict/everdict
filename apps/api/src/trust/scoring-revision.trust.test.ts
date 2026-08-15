import { ScorecardService } from "@everdict/application-control";
import type { CaseCommitReceipt, CaseResult, ScorecardRecord } from "@everdict/contracts";
import { PgScorecardStore } from "@everdict/db";
import { appendScoringRevision, caseObservationDigest, currentScoringPin, inputObservationOf } from "@everdict/domain";
import { InMemoryDatasetRegistry } from "@everdict/registry";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRUST_PG_ENABLED, type TrustPg, openTrustPg, trustId } from "./trust-context.js";

// Trust suite (docs/trust-certification.md) — TRUST-35.
//
// SCORING IDENTITY IS APPEND-ONLY, AND A GATE PINS WHAT IT SAW. A re-score legally rewrites the score plane
// in place, so the same scorecard id can mean different judgments over time — the ledger
// (ScorecardRecord.scoring, mig 0144) is what keeps that honest, and the gate's {revision, scorePlaneDigest}
// pins are what make a post-decision re-score DETECTABLE divergence instead of silent reattribution. Only a
// real Postgres round trip can certify it: the ledger, the pins and the rescore's manifest refresh all live
// in jsonb columns, and a column the store silently drops (the manifest UPDATE lane was exactly such a hole)
// keeps every unit test green while production forgets.
const describeTrust = TRUST_PG_ENABLED ? describe : describe.skip;

// The receipt that vouches for one case's execution — the ledger row a judgment's input is checked against.
const vouching = (result: CaseResult): CaseCommitReceipt => ({
  scorecardId: "sc",
  caseId: result.caseId,
  trial: 0,
  childRunId: `child-${result.caseId}`,
  resultDigest: "sha256:committed",
  observationDigest: caseObservationDigest(result),
  committedAt: new Date().toISOString(),
});

const judged = (caseId: string, value: number, pass: boolean): CaseResult => ({
  caseId,
  harness: "h@1",
  trace: [],
  snapshot: { kind: "prompt", output: "done" },
  scores: [
    { graderId: "t", metric: "tests_pass", value: pass ? 1 : 0, pass },
    { graderId: "quality", metric: "judge:quality", value, pass },
  ],
});

describeTrust("TRUST-35 — the scoring ledger survives Postgres, and the gate's pin detects a later re-score", () => {
  let pg: TrustPg;
  let tenant: string;

  beforeAll(async () => {
    pg = await openTrustPg();
    tenant = trustId("trust-scoring");
  });
  afterAll(async () => {
    if (tenant) await pg.client.query("DELETE FROM everdict_scorecards WHERE tenant = $1", [tenant]);
    await pg?.close();
  });

  it("gate pins both sides' current revisions; a re-score appends and the record's digest walks away from the pin", async () => {
    const store = new PgScorecardStore(pg.client);
    const service = new ScorecardService({
      dispatcher: {
        async dispatch() {
          throw new Error("never dispatches");
        },
      },
      store,
      datasets: new InMemoryDatasetRegistry(),
      newId: () => trustId("g35"),
    });
    const record = (id: string, results: CaseResult[]): ScorecardRecord => ({
      id: `${tenant}-${id}`,
      tenant,
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      status: "succeeded",
      scorecard: { suiteId: "d", harness: "h@1", results },
      // The initial revision, born at settle through the SAME production append the services use.
      scoring: appendScoringRevision(undefined, {
        kind: "initial",
        judges: [{ id: "quality", version: "1.0.0", model: "m1" }],
        results,
        // …and WHAT those judges read, vouched for by the case-commit ledger (arch-review 46). It rides the
        // same jsonb column, so this trip is what certifies it survives Postgres at all.
        inputObservation: inputObservationOf(results, { kind: "read", receipts: results.map(vouching) }),
        createdAt: new Date().toISOString(),
      }),
      manifest: {
        dataset: { id: "d", version: "1.0.0", digest: "sha256:dd" },
        harness: { id: "h", version: "1" },
        judges: [{ id: "quality", version: "1.0.0", specDigest: "sha256:doc", model: "m1" }],
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const baseResults = [judged("a", 1, true)];
    const candResults = [judged("a", 1, true)];
    await store.create(record("base", baseResults));
    await store.create(record("cand", candResults));

    // The decision pins WHICH judgment each side's plane carried — read back through Postgres, not memory.
    const decision = await service.gate({ tenant, baseline: `${tenant}-base`, candidate: `${tenant}-cand` });
    const stored = (await store.get(`${tenant}-cand`)) as ScorecardRecord;
    const baseStored = (await store.get(`${tenant}-base`)) as ScorecardRecord;
    expect(decision.baselineScoring).toEqual(currentScoringPin(baseStored.scoring));
    expect(decision.candidateScoring).toMatchObject({
      revision: 1,
      scorePlaneDigest: stored.scoring?.[0]?.scorePlaneDigest,
    });
    // …and the pin carries the INPUT half too (arch-review 46): what the judges read, and the ledger's answer
    // about whether it still vouches for it. Both halves round-tripped through jsonb.
    expect(decision.candidateScoring?.inputObservation).toMatchObject({ completed: true, diverged: 0 });
    expect(decision.candidateScoring?.inputObservation?.setDigest).toMatch(/^sha256:/);

    // A re-score pass rewrites the plane (quality flips its verdict) and APPENDS — history intact, the
    // manifest's judge view refreshed in the same write (the update lane that used to drop `manifest`).
    const rescored = [judged("a", 0, false)];
    const scoring = appendScoringRevision(stored.scoring, {
      kind: "rescore",
      judges: [{ id: "quality", version: "2.0.0", model: "m2" }],
      results: rescored,
      // The SAME executions, judged again — so the input observation is unchanged while the plane moves,
      // which is precisely the split the two digests exist to express.
      inputObservation: inputObservationOf(rescored, { kind: "read", receipts: rescored.map(vouching) }),
      createdAt: new Date().toISOString(),
    });
    await store.update(`${tenant}-cand`, {
      scoring,
      scorecard: { suiteId: "d", harness: "h@1", results: rescored },
      manifest: {
        dataset: { id: "d", version: "1.0.0", digest: "sha256:dd" },
        harness: { id: "h", version: "1" },
        judges: [{ id: "quality", version: "2.0.0", specDigest: "sha256:doc2", model: "m2" }],
      },
      updatedAt: new Date().toISOString(),
    });

    const fresh = (await store.get(`${tenant}-cand`)) as ScorecardRecord;
    expect(fresh.scoring).toHaveLength(2); // append-only, and the jsonb column round-trips
    expect(fresh.scoring?.[0]).toEqual(stored.scoring?.[0]); // history never rewritten
    expect(fresh.manifest?.judges?.[0]).toMatchObject({ version: "2.0.0", model: "m2" }); // identity followed the judgment
    // THE CLAIM: the record's current judgment no longer matches what the decision judged — detectable, not silent.
    const now = currentScoringPin(fresh.scoring);
    expect(now?.revision).toBe(2);
    expect(now?.scorePlaneDigest).not.toBe(decision.candidateScoring?.scorePlaneDigest);
    // …while the INPUT stayed put: the same executions were judged twice, so the judgment moved and what it
    // was judged FROM did not. A pin that could not tell those apart cannot say why a verdict changed.
    expect(now?.inputObservation?.setDigest).toBe(decision.candidateScoring?.inputObservation?.setDigest);
  });
});
