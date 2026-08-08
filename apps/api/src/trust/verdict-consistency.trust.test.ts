import { RunService } from "@everdict/application-control";
import type { CaseResult, RunRecord, ScorecardRecord } from "@everdict/contracts";
import { PgRunStore, PgScorecardStore } from "@everdict/db";
import { caseVerdict, composeVerdictPolicy, resolvePolicyResolution, verdictPolicyRef } from "@everdict/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRUST_PG_ENABLED, type TrustPg, openTrustPg, trustId } from "./trust-context.js";

// Trust suite (docs/trust-certification.md) — TRUST-12.
//
// The invariant: THE SAME EVIDENCE HAS ONE VERDICT — a scorecard child's served RunRecord.verdict is derived
// under its PARENT's stamped/composed policy, so the run detail and the scorecard case dialog answer
// identically about the same CaseResult one click apart. Why only a real database can prove it: the child →
// parent → stamped-policy → manifest chain crosses two Pg stores' row mappers (jsonb round-trips of the
// composed document and the child's parentScorecardId), and an in-memory fake agrees with ANY mapping,
// including one that drops the manifest and silently re-judges under today's ladder.
const describeTrust = TRUST_PG_ENABLED ? describe : describe.skip;

describeTrust("TRUST-12 — a child run's served verdict is its parent's stamped policy, not today's ladder", () => {
  let pg: TrustPg;
  let tenant: string;

  beforeAll(async () => {
    pg = await openTrustPg();
    tenant = trustId("trust-verdict");
  });
  afterAll(async () => {
    if (tenant) {
      await pg.client.query("DELETE FROM everdict_runs WHERE tenant = $1", [tenant]);
      await pg.client.query("DELETE FROM everdict_scorecards WHERE tenant = $1", [tenant]);
    }
    await pg?.close();
  });

  it("run detail ≡ scorecard case verdict under a composed policy that DISAGREES with the default ladder", async () => {
    const runs = new PgRunStore(pg.client);
    const scorecards = new PgScorecardStore(pg.client);
    // A composed policy that declares custom_gate as ground truth — under it the case PASSES; under the
    // default ladder the judge rung decides and the case FAILS. The disagreement is the certification.
    const composed = composeVerdictPolicy([{ id: "custom_gate", authority: "ground_truth" }]);
    const result: CaseResult = {
      caseId: "c1",
      harness: "h@1",
      trace: [],
      snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
      scores: [
        { graderId: "judge", metric: "judge:quality", value: 0, pass: false },
        { graderId: "custom_gate", metric: "custom_gate", value: 1, pass: true },
      ],
    };
    expect(caseVerdict(result)).toBe(false); // today's ladder says FAIL …
    expect(caseVerdict(result, composed)).toBe(true); // … the batch's own policy says PASS

    const scorecardId = trustId("sc");
    const now = new Date().toISOString();
    const record: ScorecardRecord = {
      id: scorecardId,
      tenant,
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      status: "succeeded",
      verdictPolicy: verdictPolicyRef(composed),
      manifest: {
        dataset: { id: "d", version: "1.0.0", digest: "dd" },
        harness: { id: "h", version: "1" },
        verdictPolicy: composed,
      },
      createdAt: now,
      updatedAt: now,
    };
    await scorecards.create(record);
    const childId = trustId("run");
    const child: RunRecord = {
      id: childId,
      tenant,
      harness: { id: "h", version: "1" },
      caseId: "c1",
      status: "succeeded",
      parentScorecardId: scorecardId,
      result,
      createdAt: now,
      updatedAt: now,
    };
    await runs.create(child);

    // The application query layer, wired exactly as the composition root wires it (over the STORES).
    const service = new RunService({
      dispatcher: { dispatch: async () => Promise.reject(new Error("unused")) },
      store: runs,
      scorecardPolicy: async (t, id) => {
        const parent = await scorecards.get(id);
        if (!parent || parent.tenant !== t) return undefined;
        return resolvePolicyResolution(parent.verdictPolicy, parent.manifest?.verdictPolicy);
      },
    });
    const served = await service.get(childId);
    expect(served?.verdict).toBe(true); // the parent's stamped policy — round-tripped through Postgres — decides
    expect(served?.verdict).toBe(caseVerdict(result, composed)); // one evidence, one verdict, both surfaces
  });
});
