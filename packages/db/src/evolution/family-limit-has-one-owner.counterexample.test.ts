import type { CampaignFrame, EvolutionCampaignRecord } from "@everdict/contracts";
import { ConflictError } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryEvolutionCampaignStore } from "./campaign-store.js";

// ── THE HELD-OUT FAMILY SIZE WAS READ TWICE (review of the follow-up batch, Important) ───────────────
//
// `significance.heldOutFamilySize` is what a chain corrects its rounds against, and two doors read the field
// separately with opposite answers to the one value the schema still permits — a root that never declared it.
// The chain door refused, blaming a budget shortfall it had not measured (`{reserved, limit: undefined}`); the
// reservation door defaulted to `budget.maxRounds` and admitted. Same field, same absence, and an operator
// reading the refusal is sent to widen a number that was never the problem.
//
// One owner (`experimentFamilyLimit`), three-valued rather than defaulted, and each door STATES what it does
// with the absence instead of arriving at it (rule `protocol` L3). The two answers still differ — that is the
// point — but they differ on purpose and in words.
const legacyFrame: CampaignFrame = {
  subject: { type: "agent", id: "everdict", baselineVersion: "1.0.0" },
  scenarios: [
    { id: "c1", heldOut: true },
    { id: "c2", heldOut: true },
  ],
  judges: [],
  trialsPerCase: 5,
  budget: { maxRounds: 2 },
  stopAfterRejectedRounds: 3,
  // The whole subject: a root frozen before `campaignFrameDefects` required the family. It stays READABLE —
  // that is why the field is still optional — so both doors meet it.
  significance: { fdrAlpha: 0.05 },
  allowUnverifiedIdentity: false,
  allowLabelOnlyAdoption: false,
  oracleScope: [],
  targets: [],
  observationPolicy: { allowDivergent: false },
};

const record = (over: Partial<EvolutionCampaignRecord> = {}): EvolutionCampaignRecord => ({
  id: "legacy-root",
  tenant: "acme",
  issueId: "iss_1",
  frame: legacyFrame,
  frameDigest: "sha256:frame",
  rounds: [],
  state: "open",
  createdBy: "alice",
  createdAt: "2026-08-26T00:00:00.000Z",
  updatedAt: "2026-08-26T00:00:00.000Z",
  ...over,
});

const reservation = (campaignId: string, requestId: string) => ({
  tenant: "acme",
  campaignId,
  requestId,
  side: "candidate" as const,
  candidateVersion: "1.0.1",
  scorecardId: `${requestId}-cand`,
  requestDigest: `${requestId}-cand`,
  at: "2026-09-10T00:00:00.000Z",
  caseIds: ["c1", "c2"],
  trials: 5,
});

describe("the experiment family's size has one owner", () => {
  it("refuses a continuation of an undeclared family FOR THAT REASON, not for a budget it never measured", async () => {
    const store = new InMemoryEvolutionCampaignStore();
    await store.create(record({ state: "no_improvement" }));
    const refusal = await store
      .create(record({ id: "successor", frame: { ...legacyFrame, continues: "legacy-root" } }))
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(refusal).toBeInstanceOf(ConflictError);
    // The counterexample. Before the repair this said "insufficient unreserved held-out budget" over a
    // `limit: undefined` — a refusal that names the wrong repair is a refusal nobody can act on.
    expect((refusal as ConflictError).message).toMatch(/declares no held-out family size/);
    expect((refusal as ConflictError).message).not.toMatch(/insufficient unreserved/);
  });

  it("still lets the legacy root spend the budget it froze — its family is itself, said out loud", async () => {
    const store = new InMemoryEvolutionCampaignStore();
    await store.create(record());
    await store.reserveEvaluation(reservation("legacy-root", "r1"));
    await store.reserveEvaluation(reservation("legacy-root", "r2"));
    // limit + 1 — the door that admits an undeclared family still BOUNDS it, at the root's own frozen
    // `budget.maxRounds` and not at infinity. The store returns no family, so the bound is read where it is
    // spent rather than asserted on a field.
    await expect(store.reserveEvaluation(reservation("legacy-root", "r3"))).rejects.toThrow(
      /experiment family or campaign evaluation budget is exhausted/,
    );
  });
});
