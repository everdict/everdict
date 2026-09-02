import { ScorecardService } from "@everdict/application-control";
import type { CaseJob, CaseResult, ScorecardRecord, ScoringRevision } from "@everdict/contracts";
import { PgCaseReceiptStore, PgRunStore, PgScorecardStore } from "@everdict/db";
import { appendScoringRevision, inputObservationOf } from "@everdict/domain";
import { InMemoryDatasetRegistry } from "@everdict/registry";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRUST_PG_ENABLED, type TrustPg, openTrustPg, trustId } from "./trust-context.js";

// Trust suite (docs/trust-certification.md) — TRUST-179.
//
// RECORDED DOUBT IS ENFORCED DOUBT — FROM A REAL BATCH'S OWN RECEIPTS TO THE GREEN LIGHT.
//
// A verdict without its input is an answer with no recorded question. The receipt ledger vouches for each
// case's execution bytes; the judges read a hydrated copy; until arch-review 46 nothing compared the two, and
// until 47 P0-3 nothing a decision surface did about it. The two halves are certified separately today —
// `inputObservationOf`/`applyInputTrust` as pure functions, and the jsonb round trip in TRUST-35 over a
// HAND-BUILT record — and the seam between them is the part that has always been assumed: that a real batch,
// settling through the real service over Postgres, produces an observation the gate can and does read.
//
// So this drives the whole chain against a live database:
//
//   ① a REAL batch (real submit, real dispatch, real receipts, real settle) leaves a revision whose
//     `inputObservation` COMPLETED with zero divergence — the vouched state, produced by nothing this file
//     wrote — and the gate over two such batches carries no input reason at all;
//   ② a revision whose observation reports divergence is `not_comparable` with `input_diverged` LEADING, and
//     no policy waives it: the verdicts describe bytes the ledger has replaced, and no acknowledgement makes
//     a known-wrong subject comparable;
//   ③ a LEGACY revision — one written before input observation existed — blocks with `input_unverified` by
//     default (the owner decision: receipt-vouched input only; age is not a vouching) and passes only under
//     the recorded `allowUnverifiedInput`.
//
// Nothing here hand-writes an observation object: ② is built by handing the PRODUCTION `inputObservationOf`
// a ledger reading that disagrees, which is the only way to get a divergence report that has the shape
// production would actually store.
const describeTrust = TRUST_PG_ENABLED ? describe : describe.skip;

describeTrust("TRUST-179 — what the judges read reaches the gate, and doubt it recorded blocks there", () => {
  let pg: TrustPg;
  let tenant: string;

  beforeAll(async () => {
    pg = await openTrustPg();
    tenant = trustId("trust-input");
  });
  afterAll(async () => {
    if (tenant) {
      await pg.client.query("DELETE FROM everdict_runs WHERE tenant = $1", [tenant]).catch(() => undefined);
      await pg.client.query("DELETE FROM everdict_scorecards WHERE tenant = $1", [tenant]).catch(() => undefined);
      await pg.client.query("DELETE FROM everdict_platform_events WHERE tenant = $1", [tenant]).catch(() => undefined);
    }
    await pg?.close();
  });

  const store = (): PgScorecardStore => new PgScorecardStore(pg.client);
  const receipts = (): PgCaseReceiptStore => new PgCaseReceiptStore(pg.client);

  // One real batch, end to end: submit → dispatch → receipts → settle, all through Postgres. The scoring
  // revision this leaves behind is the subject of every assertion below, and no line of this file writes it.
  async function settledBatch(id: string): Promise<ScorecardRecord> {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register(tenant, {
      id: "input-set",
      version: "1.0.0",
      tags: [],
      cases: ["c1", "c2"].map((caseId) => ({
        id: caseId,
        env: { kind: "prompt" as const },
        task: "t",
        graders: [],
        timeoutSec: 60,
        tags: [],
      })),
    });
    const svc = new ScorecardService({
      dispatcher: {
        async dispatch(job: CaseJob): Promise<CaseResult> {
          return {
            caseId: job.evalCase.id,
            harness: "scripted@0",
            trace: [],
            snapshot: { kind: "prompt", output: `ran ${job.evalCase.id}` },
            // NOT a reserved authority name. `tests_pass` belongs to the built-in grader that produces it,
            // so a scripted producer emitting it has its score marked `invalid` at the boundary (rule
            // `suite`: declaring an authority does not grant another producer's name). This fixture then
            // carried a plane with no MEASURED score, the diff found no metrics, and the gate answered
            // `not_comparable` for a reason that had nothing to do with what this scenario is about.
            scores: [{ graderId: "t", metric: "scripted_pass", value: 1, pass: true }],
          };
        },
      },
      store: store(),
      runStore: new PgRunStore(pg.client),
      caseReceipts: receipts(),
      datasets,
      newId: () => `${tenant}-${id}-${trustId("n")}`,
    });
    const submitted = await svc.submit({
      tenant,
      dataset: { id: "input-set", version: "1.0.0" },
      harness: { id: "scripted", version: "0" },
      submittedBy: "u-trust",
      concurrency: 2,
    });
    const deadline = Date.now() + 30_000;
    let record = await store().get(submitted.id);
    while (record && record.status !== "succeeded" && record.status !== "failed" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      record = await store().get(submitted.id);
    }
    if (!record) throw new Error(`the ${id} batch vanished`);
    expect(record.status, `the ${id} batch reached a terminal state`).toBe("succeeded");
    return record;
  }

  it("a real batch's settled revision vouches for its own input, and a gate over two of them carries no doubt", async () => {
    const baseline = await settledBatch("base");
    const candidate = await settledBatch("cand");

    // ① The observation the SETTLE wrote, read back out of jsonb. `completed` says the comparison could be
    // made at all; `diverged: 0` says every judged case matched the receipt that vouches for its execution.
    for (const record of [baseline, candidate]) {
      const revision = record.scoring?.at(-1);
      expect(revision?.kind).toBe("initial");
      expect(revision?.inputObservation?.completed, `${record.id} could compare its inputs to the ledger`).toBe(true);
      expect(revision?.inputObservation?.diverged).toBe(0);
      expect(revision?.inputObservation?.cases).toBe(2);
      expect(revision?.inputObservation?.setDigest).toMatch(/^sha256:/);
      expect(revision?.inputObservation?.receiptSetDigest).toBe(revision?.inputObservation?.setDigest);
    }
    // …and the ledger really is the source of that answer: the receipts exist, one per case.
    expect(await receipts().list(candidate.id)).toHaveLength(2);

    const decision = await gateOf(baseline.id, candidate.id);
    expect(decision.reasons.map((reason) => reason.kind)).not.toContain("input_diverged");
    expect(decision.reasons.map((reason) => reason.kind)).not.toContain("input_unverified");
    expect(decision.decision, "vouched input on both sides is simply not a reason").toBe("pass");
    // The pin carries the input half through Postgres, which is what a later auditor reads.
    expect(decision.candidateScoring?.inputObservation).toMatchObject({ completed: true, diverged: 0 });
  }, 120_000);

  it("a revision reporting divergence is not_comparable — and no acknowledgement waives it", async () => {
    const baseline = await settledBatch("base-div");
    const candidate = await settledBatch("cand-div");
    // The judged plane comes back through the RECEIPT-CANONICAL hydration the service owns — the raw row's
    // `scorecard.results` is not where a settled batch's answer lives any more (arch-review 47 P1-5), and
    // rebuilding the plane from anywhere else would digest a set the revision never judged.
    const hydrated = await hydratedBatch(candidate.id);
    const results = hydrated.scorecard?.results ?? [];
    expect(results.length).toBe(2);

    // The divergence is DERIVED, not typed in: the production observation builder is handed the real judged
    // plane and a ledger reading whose digests no longer match it — the shape a case re-driven between
    // hydration and settle leaves behind. A hand-written `{diverged: 1}` would certify the gate against an
    // object production never produces.
    const committed = await receipts().list(candidate.id);
    const observation = inputObservationOf(results, {
      kind: "read",
      receipts: committed.map((receipt) => ({
        caseId: receipt.caseId,
        trial: receipt.trial,
        observationDigest: "sha256:the-execution-was-replaced",
      })),
    });
    expect(observation.completed, "the comparison itself succeeded — what it found is the problem").toBe(true);
    expect(observation.diverged).toBe(2);
    await store().update(candidate.id, {
      scoring: appendScoringRevision(hydrated.scoring, {
        kind: "rescore",
        judges: hydrated.scoring?.at(-1)?.judges ?? [],
        results,
        inputObservation: observation,
        createdAt: new Date().toISOString(),
      }),
      updatedAt: new Date().toISOString(),
    });

    const decision = await gateOf(baseline.id, candidate.id);
    expect(decision.decision).toBe("not_comparable");
    expect(decision.reasons[0]?.kind, "the doubt LEADS — it is why there is no verdict, not a footnote").toBe(
      "input_diverged",
    );
    expect(decision.reasons[0]?.count).toBe(2);
    // Not waivable, by construction: the acknowledgement exists for input nobody could vouch for, never for
    // input the ledger positively says has been replaced.
    const waived = await gateOf(baseline.id, candidate.id, { allowUnverifiedInput: true });
    expect(waived.decision).toBe("not_comparable");
    expect(waived.reasons.map((reason) => reason.kind)).toContain("input_diverged");
  }, 120_000);

  it("a legacy revision — one written before input observation existed — blocks by default and passes only when the waiver is RECORDED", async () => {
    const baseline = await settledBatch("base-legacy");
    const candidate = await settledBatch("cand-legacy");
    const current = candidate.scoring?.at(-1);
    if (!current) throw new Error("the settle appended a revision");
    // What a pre-46 row looks like: everything the revision has ever carried, minus the field that did not
    // exist yet. Absence is the whole subject here, so it has to be a genuine absence in the jsonb column.
    const { inputObservation: _predatesObservation, ...legacy } = current;
    const legacyScoring: ScoringRevision[] = [legacy];
    await store().update(candidate.id, { scoring: legacyScoring, updatedAt: new Date().toISOString() });
    expect((await store().get(candidate.id))?.scoring?.at(-1)?.inputObservation).toBeUndefined();

    const blocked = await gateOf(baseline.id, candidate.id);
    expect(blocked.decision, "nothing states what those judges read, so there is no comparison to pass").toBe(
      "not_comparable",
    );
    expect(blocked.reasons[0]?.kind).toBe("input_unverified");
    expect(blocked.reasons[0]?.detail).toContain("predates input observation");

    // The only way through is a policy that SAYS SO — and the decision keeps that acknowledgement.
    const acknowledged = await gateOf(baseline.id, candidate.id, { allowUnverifiedInput: true });
    expect(acknowledged.reasons.map((reason) => reason.kind)).not.toContain("input_unverified");
    expect(acknowledged.decision).toBe("pass");
    expect(acknowledged.policy?.allowUnverifiedInput, "a waiver nobody can read afterwards is not a waiver").toBe(true);
  }, 120_000);

  async function hydratedBatch(id: string): Promise<ScorecardRecord> {
    const record = await readerService().get(id);
    if (!record) throw new Error(`the batch ${id} vanished`);
    return record;
  }

  // A read-only service over the same Postgres — the surface a viewer and a gate both go through.
  function readerService(): ScorecardService {
    return new ScorecardService({
      dispatcher: {
        async dispatch(): Promise<CaseResult> {
          throw new Error("the reader never dispatches");
        },
      },
      store: store(),
      runStore: new PgRunStore(pg.client),
      caseReceipts: receipts(),
      datasets: new InMemoryDatasetRegistry(),
    });
  }

  async function gateOf(
    baseline: string,
    candidate: string,
    policy?: { allowUnverifiedInput?: boolean },
  ): Promise<Awaited<ReturnType<ScorecardService["gate"]>>> {
    return readerService().gate({ tenant, baseline, candidate, ...(policy ? { policy } : {}) });
  }
});
