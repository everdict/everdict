import { equalArmFisherFloor } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { fisherExactTwoSided } from "./trials.js";

// ── THE FLOOR AND THE TEST ARE ONE FACT, PINNED ACROSS THE CONE BOUNDARY ──────────────────────────
//
// `campaignFrameDefects` refuses a frame whose declared `trialsPerCase` cannot reach its corrected level, and
// it does that from `equalArmFisherFloor` — an arithmetic shortcut for "the smallest p this test can return
// over two arms of n" — because contracts is the root the creation schema lives in and the test lives here.
//
// Two spellings of one fact is the divergence rule protocol L3 is about, so this is where they are held
// together: the shortcut must equal what the real test says about the perfect-separation table, and must
// genuinely BE the minimum over every table those arms can produce. Drift makes the refusal wrong in one of
// the two dangerous directions — a dead frame accepted, or a workable frame refused — and neither shows up
// anywhere else.
describe("equalArmFisherFloor is the minimum of fisherExactTwoSided over equal arms", () => {
  it("equals the exact test at perfect separation, for every n the refusal is asked about", () => {
    for (let n = 1; n < 30; n++)
      expect(equalArmFisherFloor(n), `n=${n}`).toBeCloseTo(fisherExactTwoSided(0, n, n, n), 12);
  });

  it("no other outcome of those arms goes below it", () => {
    for (let n = 2; n <= 12; n++) {
      const floor = equalArmFisherFloor(n);
      for (let b = 0; b <= n; b++)
        for (let c = 0; c <= n; c++)
          expect(fisherExactTwoSided(b, n, c, n), `n=${n} ${b}/${n} → ${c}/${n}`).toBeGreaterThanOrEqual(floor - 1e-12);
    }
  });

  it("answers 1 for a degenerate n, so a frame is never refused on a floor that is not one", () => {
    expect(equalArmFisherFloor(1)).toBe(1);
    expect(equalArmFisherFloor(0)).toBe(1);
    expect(equalArmFisherFloor(-3)).toBe(1);
    expect(equalArmFisherFloor(2.5)).toBe(1);
  });
});
