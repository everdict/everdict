import { InMemoryCaseReceiptStore, ScorecardService } from "@everdict/application-control";
import type { CaseResult, RunRecord, ScorecardRecord } from "@everdict/contracts";
import { InMemoryRunStore, InMemoryScorecardStore } from "@everdict/db";
import { evidenceIdentityHolds, judgedPlane, observedEvidenceIdentity } from "@everdict/domain";
import { describe, expect, it } from "vitest";

// Trust suite (docs/trust-certification.md) — TRUST-144.
//
// SAME PROJECTION CODE IS NOT SAME PROJECTION SOURCE.
//
// The verifier's evidence pin and the verifier's observation call the same projection function, which is
// what makes them comparable — and for a dispatched batch they were reading two different documents. The
// stored row keeps `runIds` and no plane at all (dedup: the results live on the child runs); the service
// hydrates the plane from those children on read, and `get_scorecard` serves the hydrated one.
//
// So the pin computed a digest over a document with no plane while the reader observed the real one, and an
// ordinary production scorecard — with nobody touching anything — reported `evidence_moved`. A guard that
// cries wolf on the normal path is worse than no guard: it teaches its readers to route around it.
//
// This certifies the PARITY, over the production storage shape: row with runIds only, results on children.
const describeTrust = process.env.EVERDICT_TRUST_SUITE === "1" ? describe : describe.skip;

describeTrust("TRUST-144 — the evidence pin and the verifier's read see the same document", () => {
  const result = (caseId: string, pass: boolean): CaseResult =>
    ({
      caseId,
      harness: "h@1",
      trace: [],
      scores: [{ graderId: "g", metric: "quality", value: pass ? 1 : 0, pass, status: "measured" }],
      snapshot: { kind: "prompt", output: "done" },
    }) as unknown as CaseResult;

  async function world() {
    const scorecards = new InMemoryScorecardStore();
    const runs = new InMemoryRunStore();
    // THE PRODUCTION SHAPE: the batch row carries `runIds`, never the plane.
    await scorecards.create({
      id: "sc-1",
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "h", version: "1.0.0" },
      status: "succeeded",
      runIds: ["child-1"],
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
    } as unknown as ScorecardRecord);
    await runs.create({
      id: "child-1",
      tenant: "acme",
      harness: { id: "h", version: "1.0.0" },
      caseId: "c-1",
      parentScorecardId: "sc-1",
      status: "succeeded",
      result: result("c-1", true),
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
    } as unknown as RunRecord);
    const service = new ScorecardService({
      store: scorecards,
      runStore: runs,
      caseReceipts: new InMemoryCaseReceiptStore(),
      dispatcher: {
        async dispatch() {
          throw new Error("this scenario never dispatches");
        },
      },
      newId: () => "t144",
    } as never);
    return { scorecards, runs, service };
  }

  it("a child-backed batch pins and observes the SAME plane", async () => {
    const { service } = await world();
    // The pin, taken the way the composition takes it: the service's hydrating read.
    const pinned = judgedPlane((await service.get("sc-1")) as unknown as Record<string, unknown>);
    // The observation, taken the way the reader's tool serves it — the same read.
    const observed = observedEvidenceIdentity("scorecard", (await service.get("sc-1")) as unknown as object);
    expect(pinned.planeDigest).toBeDefined();
    expect(evidenceIdentityHolds({ kind: "scorecard", ...pinned }, observed as never)).toBe(true);
  });

  it("the RAW row is what the mismatch looked like — pinning from it identifies nothing", async () => {
    // Kept as a scenario rather than a comment: this is the shape the pin had, and the reason it reported a
    // moved artifact on a batch nobody had touched. If someone points the pin back at the raw store, this
    // fails and names why.
    const { scorecards, service } = await world();
    const raw = judgedPlane((await scorecards.get("sc-1")) as unknown as Record<string, unknown>);
    const served = judgedPlane((await service.get("sc-1")) as unknown as Record<string, unknown>);
    expect(raw.planeDigest).toBeUndefined();
    expect(served.planeDigest).toBeDefined();
  });

  it("…and a re-judged child DOES move the plane — the pin still catches a real change", async () => {
    const { runs, service } = await world();
    const before = judgedPlane((await service.get("sc-1")) as unknown as Record<string, unknown>);
    await runs.update("child-1", { result: result("c-1", false) } as never);
    const after = judgedPlane((await service.get("sc-1")) as unknown as Record<string, unknown>);
    expect(after.planeDigest).not.toBe(before.planeDigest);
  });
});
