import { BadRequestError, type Dataset } from "@everdict/contracts";
import { duplicateJudgeIds } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import type { DatasetRegistry } from "../ports/dataset-registry.js";
import type { ScorecardStore } from "../ports/scorecard-store.js";
import { ScorecardService } from "./scorecard-service.js";

// Trust suite (docs/trust-certification.md) — TRUST-71.
//
// A JUDGE OWNS A METRIC FAMILY, SO A SELECTION MAY NAME IT ONCE.
//
// `judge:<id>` and its criterion children are one family, and everything below is keyed the same way:
// `pendingJudgesFor`, `stripJudgeScores`, the per-judge attempt budget, and the scoring stage's natural key
// (case, judgeId). Two versions of one judge in a single selection is not a richer request — it is a state
// the plane cannot represent. They would write the same metric family, claim the same stage row, and a
// Postgres upsert whose statement carries one conflict key twice fails outright.
//
// So it is refused at the DOOR, in the service both transports call, before a provider is billed or a stage
// row is claimed. Discovering it at judging time would mean paying for the call that then cannot be recorded.
const describeTrust = process.env.EVERDICT_TRUST_SUITE === "1" ? describe : describe.skip;

const dataset = (): Dataset => ({
  id: "d",
  version: "1.0.0",
  cases: [{ id: "c1", env: { kind: "prompt" }, task: "do", graders: [], timeoutSec: 60, tags: [] }],
  tags: [],
});

describeTrust("TRUST-71 — a duplicate judge id is refused before anything runs", () => {
  const service = () =>
    new ScorecardService({
      dispatcher: {
        async dispatch() {
          throw new Error("dispatch must not be reached — the selection is refused at the door");
        },
      },
      store: {
        async create() {
          throw new Error("no record may be created for a malformed selection");
        },
        async update() {
          throw new Error("unused");
        },
        async get() {
          return undefined;
        },
        async list() {
          return [];
        },
        async delete() {
          return false;
        },
      } as ScorecardStore,
      datasets: {
        async get(): Promise<Dataset> {
          return dataset();
        },
        async versions() {
          return ["1.0.0"];
        },
      } as unknown as DatasetRegistry,
    });

  it("submit refuses two VERSIONS of one judge — uniqueness is by id, not by (id, version)", async () => {
    await expect(
      service().submit({
        tenant: "acme",
        dataset: { id: "d", version: "1.0.0" },
        harness: { id: "scripted", version: "0" },
        judges: [
          { id: "quality", version: "1.0.0" },
          { id: "quality", version: "2.0.0" },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("the re-score door refuses it too — the pass's selection is the unit the stage claims", async () => {
    await expect(
      service().scoreGroup({
        tenant: "acme",
        id: "sc-1",
        judges: [
          { id: "quality", version: "1.0.0" },
          { id: "quality", version: "1.0.0" },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("…and DISTINCT judges pass — the guard is about the family, not about arity", () => {
    expect(duplicateJudgeIds([{ id: "quality" }, { id: "safety" }])).toEqual([]);
    expect(duplicateJudgeIds([{ id: "quality" }, { id: "quality" }, { id: "safety" }, { id: "safety" }])).toEqual([
      "quality",
      "safety",
    ]);
  });
});
