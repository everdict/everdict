// The measurement the intent beside this file rests on, so its numbers can be re-derived rather than believed.
//
//   pnpm -F @everdict/domain build
//   node intent/2026-09-11-a-selection-split-and-declared-edits/power.mjs
//
// It imports this repository's OWN `fisherExactTwoSided` and `benjaminiHochberg` — the two functions the
// adoption gate actually calls — instead of reimplementing them, because a predicate written twice has
// already diverged (rule `protocol` L3). A power table computed against a second Fisher would be a statement
// about that second Fisher.
//
// The question: a campaign round is judged at `fdrAlpha / heldOutFamilySize`, with Benjamini-Hochberg across
// the round's cases, and the family must be at least `budget.maxRounds` because every round consults the
// held-out set. So what does an optimizer loop that wants MANY candidate steps actually pay?
//
// ⚠️ Parts B-E are Monte Carlo, so the third decimal moves between runs. The conclusion they inform — that a
// selection split buys back the FAMILY correction and not the per-case one — does not turn on that digit.
import { benjaminiHochberg, fisherExactTwoSided } from "../../packages/domain/dist/scorecard/trials.js";

const FDR_ALPHA = 0.05;
const BASELINE_RATE = 0.2;
const CANDIDATE_RATE = 0.6;
const HELD_OUT_CASES = 10;
const STEPS = 20; // one optimizer epoch

const logFactorial = (() => {
  const cache = [0];
  return (n) => {
    for (let i = cache.length; i <= n; i++) cache[i] = cache[i - 1] + Math.log(i);
    return cache[n];
  };
})();

/** P(exactly k passes in n trials at rate p). */
function binomial(n, k, p) {
  const logChoose = logFactorial(n) - logFactorial(k) - logFactorial(n - k);
  const logP = p > 0 ? k * Math.log(p) : k === 0 ? 0 : Number.NEGATIVE_INFINITY;
  const logQ = p < 1 ? (n - k) * Math.log(1 - p) : k === n ? 0 : Number.NEGATIVE_INFINITY;
  return Math.exp(logChoose + logP + logQ);
}

/**
 * EXACT power for ONE case, ignoring the other cases in the round: the probability that a genuinely improved
 * case is both an improvement and clears `alpha`. This is the optimistic reading — it is what the round would
 * do if every held-out case moved together, which is the framing the repository's own worked example uses.
 */
function exactSingleCasePower(trials, baselineRate, candidateRate, alpha) {
  let power = 0;
  for (let baselinePasses = 0; baselinePasses <= trials; baselinePasses++) {
    const wBaseline = binomial(trials, baselinePasses, baselineRate);
    if (wBaseline < 1e-15) continue;
    for (let candidatePasses = 0; candidatePasses <= trials; candidatePasses++) {
      const wCandidate = binomial(trials, candidatePasses, candidateRate);
      if (wCandidate < 1e-15) continue;
      if (candidatePasses <= baselinePasses) continue; // must be an improvement, not merely a difference
      if (fisherExactTwoSided(baselinePasses, trials, candidatePasses, trials) <= alpha)
        power += wBaseline * wCandidate;
    }
  }
  return power;
}

const drawPasses = (trials, rate) => {
  let passes = 0;
  for (let i = 0; i < trials; i++) if (Math.random() < rate) passes++;
  return passes;
};

/**
 * P(at least one TRULY improved case is flagged significant) for a whole round: `cases` held-out cases, of
 * which `moved` genuinely improved, judged by BH at `q` exactly as `trialComparison` judges them. This is the
 * realistic reading, and it is much harsher than the single-case one — with one case moving among ten nulls,
 * BH degenerates toward Bonferroni and the effective bar is roughly `q / cases`.
 */
function roundPower(cases, moved, trials, q, iterations = 30_000) {
  let hits = 0;
  for (let iteration = 0; iteration < iterations; iteration++) {
    const pValues = [];
    const improved = [];
    for (let i = 0; i < cases; i++) {
      const rate = i < moved ? CANDIDATE_RATE : BASELINE_RATE;
      const baselinePasses = drawPasses(trials, BASELINE_RATE);
      const candidatePasses = drawPasses(trials, rate);
      pValues.push(fisherExactTwoSided(baselinePasses, trials, candidatePasses, trials));
      improved.push(candidatePasses > baselinePasses);
    }
    const rejected = benjaminiHochberg(pValues, q);
    for (let i = 0; i < moved; i++)
      if (rejected.has(i) && improved[i]) {
        hits++;
        break;
      }
  }
  return hits / iterations;
}

const pad = (value, width) => String(value).padStart(width);

console.log("=== A. per-case power, threshold = fdrAlpha / family (exact) ===");
console.log(`    baseline ${BASELINE_RATE} -> candidate, two-sided Fisher, n trials per side\n`);
console.log(["family", "alpha", "n", "p1=0.40", "p1=0.60", "p1=0.80", "p1=1.00"].map((h) => pad(h, 9)).join(""));
for (const family of [5, 10, 20, 50]) {
  const alpha = FDR_ALPHA / family;
  for (const trials of [5, 7, 10, 20, 50]) {
    const cells = [0.4, 0.6, 0.8, 1.0].map((rate) =>
      pad(exactSingleCasePower(trials, BASELINE_RATE, rate, alpha).toFixed(3), 9),
    );
    console.log([pad(family, 9), pad(alpha.toExponential(1), 9), pad(trials, 9)].join("") + cells.join(""));
  }
  console.log("");
}
console.log("    ⚠️ family >= 10 with n=5 is ZERO for every effect size: the smallest two-sided Fisher p at");
console.log("       n=5 is 0.0079, which is above the 0.005 threshold. No improvement can clear it.\n");

console.log(`=== B. BH across ${HELD_OUT_CASES} held-out cases, only some of them moving (Monte Carlo) ===`);
console.log(`    P(at least one true ${BASELINE_RATE} -> ${CANDIDATE_RATE} improvement is flagged)\n`);
console.log(["family", "q", "n", "1 moved", "3 moved", "all moved"].map((h) => pad(h, 10)).join(""));
for (const family of [5, 10, 20]) {
  const q = FDR_ALPHA / family;
  for (const trials of [10, 20, 50]) {
    const cells = [1, 3, HELD_OUT_CASES].map((moved) =>
      pad(roundPower(HELD_OUT_CASES, moved, trials, q).toFixed(3), 10),
    );
    console.log([pad(family, 10), pad(q.toExponential(1), 10), pad(trials, 10)].join("") + cells.join(""));
  }
}
console.log("\n    The repository's own worked example is the RIGHTMOST column. The leftmost is what an");
console.log("    optimizer's incremental edit actually looks like, and it is two orders of magnitude worse.\n");

console.log("=== C. the same evidential standard, two ways (1 of 10 moved) ===\n");
console.log(["n/side", "family=20 (today)", "family=1 (split)"].map((h, i) => pad(h, i === 0 ? 8 : 20)).join(""));
for (const trials of [20, 50, 75, 100, 150]) {
  const today = roundPower(HELD_OUT_CASES, 1, trials, FDR_ALPHA / STEPS);
  const split = roundPower(HELD_OUT_CASES, 1, trials, FDR_ALPHA);
  console.log(pad(trials, 8) + pad(today.toFixed(3), 20) + pad(split.toFixed(3), 20));
}

console.log(`\n=== D. total case executions for one ${STEPS}-step epoch at >=0.8 power on the claim ===\n`);
const trialsNeededFor = (q) => {
  for (const trials of [20, 50, 75, 100, 150, 200]) if (roundPower(HELD_OUT_CASES, 1, trials, q) >= 0.8) return trials;
  return undefined;
};
const todayTrials = trialsNeededFor(FDR_ALPHA / STEPS);
const splitTrials = trialsNeededFor(FDR_ALPHA);
const executions = (steps, trials) => steps * HELD_OUT_CASES * 2 * trials;
console.log(
  `  today  every step confirms, n=${todayTrials}` +
    `  ->  ${executions(STEPS, todayTrials).toLocaleString()} case executions`,
);
for (const selectionTrials of [3, 5]) {
  const total = executions(STEPS, selectionTrials) + executions(1, splitTrials);
  console.log(
    `  split  selection n=${selectionTrials} x ${STEPS} steps, then ONE confirmation n=${splitTrials}` +
      `  ->  ${total.toLocaleString()}`,
  );
}
console.log("\n  Selection needs no power: it RANKS candidates. Only the confirmation makes a claim, and the");
console.log("  family correction scales with how many claims are made rather than how many candidates were tried.");
