import type { Score } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryScoringStageStore } from "./scoring-stage-store.js";

const score = (value: number): Score => ({ graderId: "g", metric: "judge:q", value, pass: value === 1 });

// The stage exists so competing passes stop sharing one mutable structure
// (docs/architecture/scoring-plane-revisions.md). Everything below is a property of that separation, not of
// the table: whatever a superseded pass writes must be invisible to the pass that wins.
describe("scoring stage — a pass accumulates judgments nobody else can see", () => {
  it("keeps two passes' judgments for the SAME case apart", async () => {
    const stage = new InMemoryScoringStageStore();
    await stage.stage("sc-1", "pass-A", [{ caseKey: "c1#0", scores: [score(1)] }]);
    await stage.stage("sc-1", "pass-B", [{ caseKey: "c1#0", scores: [score(0)] }]);
    // This is the whole point: today both writes land on one child row and the last one wins, which is why
    // a fence has to keep the loser out. Staged, the loser simply wrote somewhere nobody reads.
    await expect(stage.staged("sc-1", "pass-A")).resolves.toEqual([{ caseKey: "c1#0", scores: [score(1)] }]);
    await expect(stage.staged("sc-1", "pass-B")).resolves.toEqual([{ caseKey: "c1#0", scores: [score(0)] }]);
  });

  it("is idempotent per case — an activity retry re-stages rather than accumulating", async () => {
    const stage = new InMemoryScoringStageStore();
    await stage.stage("sc-1", "pass-A", [{ caseKey: "c1#0", scores: [score(0)] }]);
    await stage.stage("sc-1", "pass-A", [{ caseKey: "c1#0", scores: [score(1)] }]);
    const staged = await stage.staged("sc-1", "pass-A");
    expect(staged).toHaveLength(1);
    expect(staged[0]?.scores).toEqual([score(1)]); // the retry's judgment, not a second row
  });

  it("clears one pass without touching another's work", async () => {
    const stage = new InMemoryScoringStageStore();
    await stage.stage("sc-1", "pass-A", [
      { caseKey: "c1#0", scores: [] },
      { caseKey: "c2#0", scores: [] },
    ]);
    await stage.stage("sc-1", "pass-B", [{ caseKey: "c1#0", scores: [] }]);
    await expect(stage.clear("sc-1", "pass-A")).resolves.toBe(2);
    await expect(stage.staged("sc-1", "pass-A")).resolves.toEqual([]);
    await expect(stage.staged("sc-1", "pass-B")).resolves.toHaveLength(1);
  });

  it("keeps scorecards apart, so one group's stage can never be read as another's", async () => {
    const stage = new InMemoryScoringStageStore();
    await stage.stage("sc-1", "pass-A", [{ caseKey: "c1#0", scores: [score(1)] }]);
    await expect(stage.staged("sc-2", "pass-A")).resolves.toEqual([]);
  });
});
