import { ConflictError, type ScorecardRecord, type ScoringPass } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { ScoringService } from "../execution/scoring-service.js";
import type { ScorecardStore } from "../ports/scorecard-store.js";
import type { ScorecardServiceDeps } from "./scorecard-deps.js";
import { ScorecardScoreService } from "./scorecard-score-service.js";

// Trust suite (docs/trust-certification.md) — TRUST-86.
//
// A TOKEN MAY NOT AUTHORIZE AN OPERATION IT NEVER DESCRIBED.
//
// Every internal scoring call carries a passId AND a judge selection, so the caller re-declares the operation
// its token permits — and nothing compared the two. The pass marker already holds the sealed closure, which
// makes the selection something the pass OWNS and the activity's copy an assertion to be checked. Until it
// was checked, a plumbing regression or a mistaken internal caller could present pass A's token with judge
// B's selection and clear every guard: stripping and re-judging a family the pass never sealed, on a plane
// the pass owns. The passId fence cannot see this — both halves are individually valid.
const describeTrust = process.env.EVERDICT_TRUST_SUITE === "1" ? describe : describe.skip;

const NOW = "2026-08-10T00:00:00.000Z";

const livePass = (judges: Array<{ id: string; version: string }>): ScoringPass => ({
  passId: "pass-A",
  epoch: 1,
  leaseUntil: "2999-01-01T00:00:00.000Z",
  heartbeatAt: NOW,
  targetRevision: 1,
  baseRevision: 0,
  judges,
  startedAt: NOW,
  status: "running",
});

function service(pass: ScoringPass) {
  const record = {
    id: "sc-1",
    tenant: "acme",
    dataset: { id: "d", version: "1.0.0" },
    harness: { id: "h", version: "1" },
    status: "succeeded",
    scoringPass: pass,
    scorecard: { suiteId: "d@1.0.0", harness: "h@1", results: [] },
    createdAt: NOW,
    updatedAt: NOW,
  } as unknown as ScorecardRecord;
  const store = {
    async create() {},
    async update() {
      return record;
    },
    async get() {
      return record;
    },
    async list() {
      return [];
    },
    // No rows, so no groups — the same answer its `list` gives, in the shape a GROUP BY has.
    async countByGroup() {
      return [];
    },
    async delete() {
      return false;
    },
  } as ScorecardStore;
  return new ScorecardScoreService({ store } as unknown as ScorecardServiceDeps, {
    newId: () => "id",
    now: () => NOW,
    scoring: new ScoringService({}),
    getRecord: async () => record,
    pinJudges: async (_t, j) => j,
  });
}

describeTrust("TRUST-86 — the pass owns its judge selection; the activity may not restate it", () => {
  const sealed = [{ id: "quality", version: "1.0.0" }];

  it("refuses an activity presenting a DIFFERENT judge than the pass sealed", async () => {
    await expect(
      service(livePass(sealed)).prepareScore("sc-1", [{ id: "safety", version: "1.0.0" }], "pass-A"),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses a SUPERSET too — a token cannot be widened by the caller that holds it", async () => {
    await expect(
      service(livePass(sealed)).prepareScore(
        "sc-1",
        [
          { id: "quality", version: "1.0.0" },
          { id: "safety", version: "1.0.0" },
        ],
        "pass-A",
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses a different VERSION of the same judge — the sealed closure names one document", async () => {
    await expect(
      service(livePass(sealed)).prepareScore("sc-1", [{ id: "quality", version: "2.0.0" }], "pass-A"),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("accepts the sealed selection, in any order — order is not identity", async () => {
    const pair = [
      { id: "quality", version: "1.0.0" },
      { id: "safety", version: "1.0.0" },
    ];
    await expect(service(livePass(pair)).prepareScore("sc-1", [...pair].reverse(), "pass-A")).resolves.toBeDefined();
  });

  it("a marker sealed before closures were recorded compares nothing rather than refusing everything", async () => {
    // Absence is a generation gap, not agreement — and asserting on an empty seal would strand every
    // in-flight legacy pass at the moment of deploy.
    await expect(service(livePass([])).prepareScore("sc-1", sealed, "pass-A")).resolves.toBeDefined();
  });
});
