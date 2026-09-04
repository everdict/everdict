import type { Score } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { CampaignService } from "./campaign-service.js";

// ── THE CONTROL IS CHECKED AT THE DOOR, NOT DESCRIBED IN A FIELD ─────────────────────────────────────
//
// `examProofOf` is pure and its own counterexample proves it reads a scorecard correctly. That says nothing
// about whether anything CALLS it: an optional dependency with no producer is a plan, and a frame field with
// no consumer is an annotation — the exact shape rule `protocol` is written against, and the shape this
// whole session found in `answer_position` (two readers, both wrong, no gate).
//
// So this drives `CampaignService.open` itself. A frame that names a positive control which proves nothing
// about its scenarios is REFUSED, because a check that reads as done and establishes nothing is worse than
// no check at all.
//
// RED before `verifyExamControl` was wired: the open succeeded and `record.examProof` was undefined.

const score = (value: number): Score => ({ graderId: "reward-file", metric: "reward", value });

const scorecards = (rows: Record<string, ReadonlyArray<{ caseId: string; scores: Score[] }>>) => ({
  get: async (id: string) =>
    rows[id] === undefined ? undefined : { tenant: "acme", scorecard: { results: rows[id] } },
});

describe("the positive control is enforced by the open door", () => {
  it("a frame naming a scorecard that passes NONE of its scenarios is refused", async () => {
    const svc = buildService(scorecards({ "sc-oracle": [{ caseId: "s1", scores: [score(0)] }] }));
    await expect(svc.open("acme", { issueId: "iss-1", frame: frameWith("sc-oracle") }, "user:a")).rejects.toThrow(
      /passes none of this frame's/,
    );
  });

  it("…and one that passes some of them opens, with the coverage DERIVED by the platform", async () => {
    const svc = buildService(
      scorecards({
        "sc-oracle": [
          { caseId: "s1", scores: [score(1)] },
          { caseId: "s2", scores: [score(0)] },
          { caseId: "s3", scores: [score(1)] },
        ],
      }),
    );
    const record = await svc.open("acme", { issueId: "iss-1", frame: frameWith("sc-oracle") }, "user:a");
    expect(record.examProof).toEqual({
      scorecardId: "sc-oracle",
      proven: ["s1", "s3"],
      unproven: ["s2"],
      of: 3,
    });
  });

  it("another workspace's scorecard is not a control — it reads as nonexistent", async () => {
    const svc = buildService({
      get: async () => ({ tenant: "other-co", scorecard: { results: [{ caseId: "s1", scores: [score(1)] }] } }),
    });
    await expect(svc.open("acme", { issueId: "iss-1", frame: frameWith("sc-oracle") }, "user:a")).rejects.toThrow(
      /does not have/,
    );
  });

  it("a frame that names NO control opens unproven — a hard benchmark is the ordinary case", async () => {
    const svc = buildService(scorecards({}));
    const record = await svc.open("acme", { issueId: "iss-1", frame: frameWith(undefined) }, "user:a");
    expect(record.examProof).toBeUndefined();
  });
});

function frameWith(examProvenBy: string | undefined) {
  return {
    subject: { type: "harness" as const, id: "sbench", baselineVersion: "1.0.0" },
    scenarios: [
      { id: "s1", heldOut: false },
      { id: "s2", heldOut: true },
      { id: "s3", heldOut: true },
    ],
    judges: [],
    trialsPerCase: 5,
    budget: { maxRounds: 5 },
    stopAfterRejectedRounds: 3,
    significance: { fdrAlpha: 0.05, heldOutFamilySize: 5 },
    allowUnverifiedIdentity: false,
    allowLabelOnlyAdoption: false,
    oracleScope: [],
    targets: [],
    observationPolicy: { allowDivergent: false },
    ...(examProvenBy !== undefined ? { examProvenBy } : {}),
  };
}

function buildService(cards: { get: (id: string) => Promise<unknown> }) {
  const rows = new Map<string, unknown>();
  return new CampaignService({
    store: {
      create: async (r: { id: string }) => {
        rows.set(r.id, r);
        return r;
      },
      get: async (_t: string, id: string) => rows.get(id),
    },
    scorecards: cards,
    issues: { get: async (_t: string, ref: string) => ({ id: ref, teamId: undefined, links: [] }) },
    datasets: { get: async () => ({ cases: [] }) },
    // `open` stages no evidence; the real store lives in @everdict/db, which this layer may not import.
    evidence: { stage: async () => undefined, get: async () => undefined },
    seedProvenance: { seedsOf: async () => [] },
    shape: { slotsOf: async () => [] },
    diffs: { diffSnapshot: async () => ({}) },
    operations: { create: async () => undefined, forCampaign: async () => undefined },
    changes: { pullRequestFiles: async () => ({ kind: "read" as const, value: [] }) },
    runs: { get: async () => undefined },
    newId: () => "camp-1",
    now: () => "2026-09-05T00:00:00.000Z",
  } as never);
}
