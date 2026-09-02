import { describe, expect, it } from "vitest";
import { seedLeakOf } from "./seed-leak.js";

describe("seedLeakOf — a seed whose evidence touches the held-out set is the exam mounted into the candidate", () => {
  const heldOut = new Set(["h1", "h2"]);
  it("names each leaking seed once, sorted; a seed whose evidence covers other cases is clean", () => {
    expect(
      seedLeakOf(
        [
          { seed: "knowledge:k1", scorecardId: "sc-a", caseIds: ["t1", "h2"] },
          { seed: "knowledge:k1", scorecardId: "sc-b", caseIds: ["h1"] },
          { seed: "skill:triage@1.0.0", scorecardId: "sc-c", caseIds: ["t1", "t2"] },
          { seed: "knowledge:k0", scorecardId: "sc-d", caseIds: ["h1"] },
        ],
        heldOut,
      ),
    ).toEqual(["knowledge:k0", "knowledge:k1"]);
  });
  it("no evidence, or evidence over no held-out case, is no leak", () => {
    expect(seedLeakOf([], heldOut)).toEqual([]);
    expect(seedLeakOf([{ seed: "knowledge:k1", scorecardId: "sc", caseIds: ["t1"] }], heldOut)).toEqual([]);
  });
});
