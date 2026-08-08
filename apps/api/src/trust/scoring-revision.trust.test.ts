import { ScorecardService } from "@everdict/application-control";
import type { CaseResult, ScorecardRecord } from "@everdict/contracts";
import { PgScorecardStore } from "@everdict/db";
import { appendScoringRevision, currentScoringPin } from "@everdict/domain";
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
    expect(decision.candidateScoring).toEqual({ revision: 1, scorePlaneDigest: stored.scoring?.[0]?.scorePlaneDigest });

    // A re-score pass rewrites the plane (quality flips its verdict) and APPENDS — history intact, the
    // manifest's judge view refreshed in the same write (the update lane that used to drop `manifest`).
    const rescored = [judged("a", 0, false)];
    const scoring = appendScoringRevision(stored.scoring, {
      kind: "rescore",
      judges: [{ id: "quality", version: "2.0.0", model: "m2" }],
      results: rescored,
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
  });
});
