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
    await stage.stage("sc-1", "pass-A", [{ caseKey: "c1#0", judgeId: "q", scores: [score(1)] }]);
    await stage.stage("sc-1", "pass-B", [{ caseKey: "c1#0", judgeId: "q", scores: [score(0)] }]);
    // This is the whole point: today both writes land on one child row and the last one wins, which is why
    // a fence has to keep the loser out. Staged, the loser simply wrote somewhere nobody reads.
    await expect(stage.staged("sc-1", "pass-A")).resolves.toEqual([
      { caseKey: "c1#0", judgeId: "q", scores: [score(1)], attempt: 1 },
    ]);
    await expect(stage.staged("sc-1", "pass-B")).resolves.toEqual([
      { caseKey: "c1#0", judgeId: "q", scores: [score(0)], attempt: 1 },
    ]);
  });

  // arch-review 14 §11: the pass fence cannot arbitrate two attempts of the SAME pass — Temporal retries an
  // activity inside one pass, so a timed-out attempt still running and its replacement both present the same
  // passId and both clear every guard. The winner is decided by ATTEMPT, not by arrival order: "first wins"
  // hands the record to an attempt the orchestrator already superseded, "last wins" is the mirror.
  it("lets the CURRENT attempt supersede an earlier one", async () => {
    const stage = new InMemoryScoringStageStore();
    await stage.stage("sc-1", "pass-A", [{ caseKey: "c1#0", judgeId: "q", scores: [score(0)], attempt: 1 }]);
    const accepted = await stage.stage("sc-1", "pass-A", [
      { caseKey: "c1#0", judgeId: "q", scores: [score(1)], attempt: 2 },
    ]);
    expect(accepted).toHaveLength(1); // the retry holds the right to write
    const staged = await stage.staged("sc-1", "pass-A");
    expect(staged).toHaveLength(1); // never a second row
    expect(staged[0]?.scores).toEqual([score(1)]);
  });

  it("REFUSES a late completion from an attempt that was already replaced", async () => {
    // The trap in the obvious fix: attempt 1 timed out, its provider call kept running, and it comes back
    // after attempt 2 has already answered. Its judgment is one nobody was waiting for.
    const stage = new InMemoryScoringStageStore();
    await stage.stage("sc-1", "pass-A", [{ caseKey: "c1#0", judgeId: "q", scores: [score(1)], attempt: 2 }]);
    const late = await stage.stage("sc-1", "pass-A", [
      { caseKey: "c1#0", judgeId: "q", scores: [score(0)], attempt: 1 },
    ]);
    expect(late).toEqual([]); // refused — and the caller writes nothing to the carrier either
    const staged = await stage.staged("sc-1", "pass-A");
    expect(staged[0]?.scores).toEqual([score(1)]);
  });

  it("clears one pass without touching another's work", async () => {
    const stage = new InMemoryScoringStageStore();
    await stage.stage("sc-1", "pass-A", [
      { caseKey: "c1#0", judgeId: "q", scores: [] },
      { caseKey: "c2#0", judgeId: "q", scores: [] },
    ]);
    await stage.stage("sc-1", "pass-B", [{ caseKey: "c1#0", judgeId: "q", scores: [] }]);
    await expect(stage.clear("sc-1", "pass-A")).resolves.toBe(2);
    await expect(stage.staged("sc-1", "pass-A")).resolves.toEqual([]);
    await expect(stage.staged("sc-1", "pass-B")).resolves.toHaveLength(1);
  });

  it("keeps scorecards apart, so one group's stage can never be read as another's", async () => {
    const stage = new InMemoryScoringStageStore();
    await stage.stage("sc-1", "pass-A", [{ caseKey: "c1#0", judgeId: "q", scores: [score(1)] }]);
    await expect(stage.staged("sc-2", "pass-A")).resolves.toEqual([]);
  });
});

// arch-review 12 (mig 0153): the row is per (case, JUDGE). Per case, two attempts that judged DIFFERENT
// judges collided under first-writer-wins — the second one's judgment was simply dropped, on a key that had
// no business arbitrating it.
describe("scoring stage — the row's unit is the judge, because that is what retries independently", () => {
  it("keeps two judges' judgments of the SAME case side by side", async () => {
    const stage = new InMemoryScoringStageStore();
    await stage.stage("sc-1", "pass-A", [{ caseKey: "c1#0", judgeId: "quality", scores: [score(1)] }]);
    await stage.stage("sc-1", "pass-A", [{ caseKey: "c1#0", judgeId: "safety", scores: [score(0)] }]);
    const staged = await stage.staged("sc-1", "pass-A");
    expect(staged).toHaveLength(2);
    expect(staged.map((e) => e.judgeId)).toEqual(["quality", "safety"]);
  });

  it("arbitrates per JUDGE, not per case — one judge's retry never disturbs its neighbour's row", async () => {
    const stage = new InMemoryScoringStageStore();
    await stage.stage("sc-1", "pass-A", [
      { caseKey: "c1#0", judgeId: "quality", scores: [score(1)], attempt: 1 },
      { caseKey: "c1#0", judgeId: "safety", scores: [score(1)], attempt: 1 },
    ]);
    await stage.stage("sc-1", "pass-A", [{ caseKey: "c1#0", judgeId: "quality", scores: [score(0)], attempt: 2 }]);
    const staged = await stage.staged("sc-1", "pass-A");
    expect(staged).toHaveLength(2);
    expect(staged.find((e) => e.judgeId === "quality")?.scores).toEqual([score(0)]); // superseded
    expect(staged.find((e) => e.judgeId === "safety")?.scores).toEqual([score(1)]); // untouched
  });
});
