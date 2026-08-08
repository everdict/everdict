import { ScorecardService } from "@everdict/application-control";
import type { CaseResult } from "@everdict/contracts";
import { PgScorecardStore, type ScorecardRecord } from "@everdict/db";
import { composeVerdictPolicy, sealGrading, verdictPolicyRef } from "@everdict/domain";
import { InMemoryDatasetRegistry } from "@everdict/registry";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRUST_PG_ENABLED, type TrustPg, openTrustPg, trustId } from "./trust-context.js";

// Trust suite (docs/trust-certification.md) — TRUST-02 / TRUST-03.
//
// The invariant: A RELEASE GATE NEVER ISSUES A GREEN LIGHT THE EVIDENCE DOES NOT SUPPORT. Two shapes of
// false green:
//   TRUST-02 — the candidate quietly ran fewer cases than the baseline. "Zero regressions among the 60 that
//              survived out of 100" is evidence about 60 cases, not evidence that nothing regressed.
//   TRUST-03 — the candidate's stamped verdict policy cannot be restored. Deciding anyway means re-judging
//              that batch under today's ladder: a silent retroactive rewrite of what "passing" meant.
//
// Why the trust suite repeats what the unit tests already pin: the unit tests drive an InMemory store, which
// hands the service back the very object it was given. Production hands it a row that made a round trip
// through Postgres — the stamp, the embedded manifest and the per-case results all live in jsonb columns. A
// column that silently drops the manifest turns `not_comparable` into a pass, and every unit test stays
// green while it does. (That failure mode is not hypothetical: the same shape of gap was found in this
// store's list projection while these tests were being written.) So the gate is certified over the store the
// control plane actually runs.
const describeTrust = TRUST_PG_ENABLED ? describe : describe.skip;

describeTrust(
  "TRUST-02/03 — the release gate over real Postgres refuses on missing evidence and on an unrestorable policy",
  () => {
    let pg: TrustPg;
    let tenant: string;

    beforeAll(async () => {
      pg = await openTrustPg();
    });
    afterAll(async () => {
      if (tenant) await pg.client.query("DELETE FROM everdict_scorecards WHERE tenant = $1", [tenant]);
      await pg?.close();
    });

    const scored = (caseId: string, pass: boolean): CaseResult => ({
      caseId,
      harness: "h@1",
      trace: [],
      snapshot: { kind: "prompt", output: "done" },
      scores: [{ graderId: "t", metric: "tests_pass", value: pass ? 1 : 0, pass }],
    });

    function build() {
      tenant ??= trustId("trust-gate");
      const store = new PgScorecardStore(pg.client);
      const service = new ScorecardService({
        dispatcher: {
          async dispatch() {
            throw new Error("gate never dispatches");
          },
        },
        store,
        datasets: new InMemoryDatasetRegistry(),
        // Unique per call, not a per-test counter: gate decisions ride the same-tx outbox, and the platform
        // event table enforces a unique id across every test in this file.
        newId: () => trustId("g"),
      });
      const record = (id: string, results: CaseResult[], over: Partial<ScorecardRecord> = {}): ScorecardRecord => ({
        id: `${tenant}-${id}`,
        tenant,
        dataset: { id: "d", version: "1.0.0" },
        harness: { id: "h", version: "1" },
        status: "succeeded",
        scorecard: { suiteId: "d@1.0.0", harness: "h@1", results },
        // Split-seal manifest so experiment IDENTITY verifies held — this scenario certifies the COVERAGE
        // refusal, and an unsealed pair now refuses on identity first (TRUST-27's claim, not this one's).
        // Sealed from EACH SIDE'S OWN case set, grading through the production builder (sealGrading) — the
        // hand-written identical `grading` this fixture used to carry hid the selection-keyed composite bug:
        // in production a 4-of-5 candidate's defaults composite differed and grading confounded before
        // coverage ever spoke.
        manifest: {
          dataset: { id: "d", version: "1.0.0", digest: "sha256:composite" },
          cases: Object.fromEntries(results.map((r) => [r.caseId, `sha256:case-${r.caseId}`])),
          ...sealGrading(
            undefined,
            results.map((r) => ({ id: r.caseId, graders: [] })),
          ),
          harness: { id: "h", version: "1" },
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...over,
      });
      return { store, service, record, id: (s: string) => `${tenant}-${s}` };
    }

    it("a candidate that skipped a fifth of the baseline's cases is BLOCKED_MISSING after a full Postgres round trip", async () => {
      // Given: a 5-case baseline and a candidate that only re-ran 4 of them — regressing in none of the four.
      // Both persisted to, and re-read from, real Postgres.
      const { store, service, record, id } = build();
      const cases = ["a", "b", "c", "d", "e"];
      await store.create(
        record(
          "m-base",
          cases.map((c) => scored(c, true)),
        ),
      );
      await store.create(
        record(
          "m-cand",
          cases.slice(0, 4).map((c) => scored(c, true)),
        ),
      );

      // When: the gate decides under the default (fail-closed) policy.
      const decision = await service.gate({
        tenant,
        baseline: id("m-base"),
        candidate: id("m-cand"),
        decidedBy: "ci",
      });

      // Then: it refuses. Zero regressions over 4 of 5 cases is not a green light for the suite.
      expect(decision.decision).toBe("blocked_missing");
      expect(decision.evidence).toMatchObject({ comparability: "partial", regressions: 0, missingCases: 1 });
      expect(decision.reasons.find((r) => r.kind === "missing_cases")?.count).toBe(1);

      // And: the decision was RECORDED on the candidate's ledger row — governance can only count what the
      // database kept, so a decision that survives only in the response is a decision nobody can audit.
      const reread = await service.get(id("m-cand"));
      expect(reread?.gates?.at(-1)).toMatchObject({ decision: "blocked_missing", decidedBy: "ci" });
      // The stamped policy is re-derivable from the persisted row alone, without the caller's flags.
      expect(reread?.gates?.at(-1)?.policy).toEqual({ maxRegressions: 0 });
    });

    it("a candidate whose stamped verdict policy cannot be restored is NOT_COMPARABLE, not a pass", async () => {
      // Given: a candidate stamped with a COMPOSED policy — a document that lives only in its own manifest —
      // persisted with the manifest withheld. Nothing can produce the ladder its verdicts were judged under.
      const { store, service, record, id } = build();
      const stamp = verdictPolicyRef(composeVerdictPolicy([{ id: "schema_valid", authority: "objective" }]));
      await store.create(record("p-base", [scored("a", true)]));
      // Written the way the batch lifecycle writes it: the row is inserted when the batch is submitted and the
      // policy REF is stamped when it settles. Stamping at insert time would exercise a path no caller uses.
      await store.create(record("p-cand", [scored("a", true)]));
      await store.update(id("p-cand"), { verdictPolicy: stamp });

      // When: the gate decides.
      const decision = await service.gate({ tenant, baseline: id("p-base"), candidate: id("p-cand") });

      // Then: it withholds a verdict rather than re-judging the batch under today's default ladder.
      expect(decision.decision).toBe("not_comparable");
      expect(decision.reasons[0]?.kind).toBe("policy_unresolvable");
      // And there is nothing to force: an override refuses, because the answer is "rerun a comparable pair".
      await expect(
        service.overrideGate({
          tenant,
          candidate: id("p-cand"),
          decisionId: decision.id,
          reason: "ship it anyway",
          by: "someone",
        }),
      ).rejects.toThrow();
    });

    it("two batches judged under DIFFERENT restorable policies are NOT_COMPARABLE — the stamp survives the jsonb round trip", async () => {
      // Given: two batches that each embed their own composed policy, and the two documents disagree about who
      // decides a case. Both stamps resolve; they simply resolve to different ladders.
      const { store, service, record, id } = build();
      const basePolicy = composeVerdictPolicy([{ id: "schema_valid", authority: "objective" }]);
      const candPolicy = composeVerdictPolicy([{ id: "schema_valid", authority: "ground_truth" }]);
      const manifestFor = (p: typeof basePolicy) => ({
        dataset: { id: "d", version: "1.0.0", digest: "dd" },
        harness: { id: "h", version: "1" },
        verdictPolicy: p,
      });
      // Same lifecycle split as above: the manifest (which carries the composed document) rides the insert,
      // the policy ref is stamped when the batch settles.
      await store.create(record("x-base", [scored("a", true)], { manifest: manifestFor(basePolicy) }));
      await store.update(id("x-base"), { verdictPolicy: verdictPolicyRef(basePolicy) });
      await store.create(record("x-cand", [scored("a", true)], { manifest: manifestFor(candPolicy) }));
      await store.update(id("x-cand"), { verdictPolicy: verdictPolicyRef(candPolicy) });

      // Then: the embedded documents came back out of Postgres intact enough to be told apart — which is the
      // whole point. A manifest that did not round-trip would read as "same policy" and pass.
      const decision = await service.gate({ tenant, baseline: id("x-base"), candidate: id("x-cand") });
      expect(decision.decision).toBe("not_comparable");
      expect(decision.reasons[0]?.kind).toBe("policy_mismatch");
    });
  },
);
