import { BadRequestError, type CaseResult, type Scorecard } from "@everdict/contracts";
import { caseVerdict } from "./scorecard.js";

// Trial-based verdict math — turn N repeated trials of a case into pass@k, flakiness, and a
// statistical regression gate. Pure, dependency-free (same discipline as scorecard.ts). A "trial" is
// one CaseResult; results with the same caseId are repetitions. docs/architecture/trial-based-verdict.md

// pass@k — the unbiased estimator (Chen et al., 2021): the probability that a size-k sample of the n
// trials contains at least one pass, given c of the n passed. 1 - C(n-c, k)/C(n, k), computed in the
// numerically stable product form from the paper's reference code. k is clamped to n (pass@k with k>n
// is undefined → treated as pass@n). pass@1 = c/n.
export function passAtK(n: number, c: number, k: number): number {
  if (!Number.isInteger(n) || !Number.isInteger(c) || !Number.isInteger(k))
    throw new BadRequestError("BAD_REQUEST", { n, c, k }, "passAtK expects integer n, c, k.");
  if (n <= 0) throw new BadRequestError("BAD_REQUEST", { n }, "passAtK needs at least one trial (n>0).");
  if (c < 0 || c > n) throw new BadRequestError("BAD_REQUEST", { n, c }, "passAtK needs 0 <= c <= n.");
  if (k <= 0) throw new BadRequestError("BAD_REQUEST", { k }, "passAtK needs k > 0.");
  const kk = Math.min(k, n);
  if (n - c < kk) return 1; // every size-kk sample must include a pass
  let prod = 1;
  for (let i = n - c + 1; i <= n; i++) prod *= 1 - kk / i;
  return 1 - prod;
}

// Group a scorecard's results by caseId — the N trials of a case land in one bucket (insertion order kept).
export function groupTrials(sc: Pick<Scorecard, "results">): Map<string, CaseResult[]> {
  const byCase = new Map<string, CaseResult[]>();
  for (const r of sc.results) {
    const arr = byCase.get(r.caseId) ?? [];
    arr.push(r);
    byCase.set(r.caseId, arr);
  }
  return byCase;
}

export interface CaseTrialStats {
  caseId: string;
  trials: number; // scored trials (caseVerdict defined) — n
  passes: number; // c
  passRate: number; // c/n (= pass@1); 0 when there are no scored trials
  flaky: boolean; // mixed outcomes across trials (0 < c < n)
}

// Per-case trial stats. Only trials whose caseVerdict is defined are counted (a case with no
// pass-deciding grader is excluded, same rule as scorecardPassRate).
export function caseTrialStats(caseId: string, results: CaseResult[]): CaseTrialStats {
  let trials = 0;
  let passes = 0;
  for (const r of results) {
    const v = caseVerdict(r);
    if (v === undefined) continue;
    trials++;
    if (v) passes++;
  }
  return { caseId, trials, passes, passRate: trials > 0 ? passes / trials : 0, flaky: passes > 0 && passes < trials };
}

export interface ScorecardTrialSummary {
  cases: number; // cases with >=1 scored trial
  minTrials: number; // min/max scored trials across those cases (the honest k ceiling)
  maxTrials: number;
  passAt1: number; // mean over cases of passRate (each case weighted once)
  k: number; // the k used for passAtK
  passAtK: number; // mean over cases of passAtK(trials, passes, k) — k clamped per case to its trials
  flakyCases: number;
  flakeRate: number; // flakyCases / cases
}

// Scorecard-level trial roll-up. Cases are weighted equally (not by trial count). k defaults to
// maxTrials ("did any of k attempts pass"); pass@1 is always reported.
export function summarizeTrials(sc: Pick<Scorecard, "results">, k?: number): ScorecardTrialSummary {
  const stats = [...groupTrials(sc).entries()]
    .map(([caseId, results]) => caseTrialStats(caseId, results))
    .filter((s) => s.trials > 0);
  if (stats.length === 0)
    return { cases: 0, minTrials: 0, maxTrials: 0, passAt1: 0, k: k ?? 0, flakyCases: 0, flakeRate: 0, passAtK: 0 };
  const minTrials = Math.min(...stats.map((s) => s.trials));
  const maxTrials = Math.max(...stats.map((s) => s.trials));
  const kk = k ?? maxTrials;
  const passAt1 = stats.reduce((a, s) => a + s.passRate, 0) / stats.length;
  const passAtKMean = stats.reduce((a, s) => a + passAtK(s.trials, s.passes, Math.min(kk, s.trials)), 0) / stats.length;
  const flakyCases = stats.filter((s) => s.flaky).length;
  return {
    cases: stats.length,
    minTrials,
    maxTrials,
    passAt1,
    k: kk,
    passAtK: passAtKMean,
    flakyCases,
    flakeRate: flakyCases / stats.length,
  };
}

export interface TrialCaseDelta {
  caseId: string;
  baselineRate: number;
  baselineTrials: number;
  candidateRate: number;
  candidateTrials: number;
  delta: number; // candidateRate - baselineRate
  z: number; // two-proportion z of candidate vs baseline (negative = candidate lower)
  significant: boolean; // |z| >= zThreshold
}

export interface TrialDiff {
  baseline: string;
  candidate: string;
  zThreshold: number;
  cases: TrialCaseDelta[];
  regressions: TrialCaseDelta[]; // significant AND rate dropped
  improvements: TrialCaseDelta[]; // significant AND rate rose
}

// Two-proportion z of candidate vs baseline pass rates (pooled variance, normal approximation).
// Returns 0 when the pooled variance is 0 (both all-pass or all-fail with equal rate) — no evidence of change.
function twoProportionZ(cb: number, nb: number, cc: number, nc: number): number {
  if (nb <= 0 || nc <= 0) return 0;
  const pb = cb / nb;
  const pc = cc / nc;
  const pHat = (cb + cc) / (nb + nc);
  const se = Math.sqrt(pHat * (1 - pHat) * (1 / nb + 1 / nc));
  return se > 0 ? (pc - pb) / se : 0;
}

// Statistical regression gate — baseline(vA) vs candidate(vB) over the same cases, run as trials.
// A case is a regression only when the pass-rate drop is significant at the given confidence
// (default z=1.96, ~95%), not on a single flip. Cases without scored trials on both sides are skipped.
export function diffTrials(baseline: Scorecard, candidate: Scorecard, opts: { zThreshold?: number } = {}): TrialDiff {
  const zThreshold = opts.zThreshold ?? 1.96;
  const b = groupTrials(baseline);
  const c = groupTrials(candidate);
  const cases: TrialCaseDelta[] = [];
  for (const [caseId, cResults] of c) {
    const bResults = b.get(caseId);
    if (!bResults) continue;
    const bs = caseTrialStats(caseId, bResults);
    const cs = caseTrialStats(caseId, cResults);
    if (bs.trials === 0 || cs.trials === 0) continue;
    const z = twoProportionZ(bs.passes, bs.trials, cs.passes, cs.trials);
    cases.push({
      caseId,
      baselineRate: bs.passRate,
      baselineTrials: bs.trials,
      candidateRate: cs.passRate,
      candidateTrials: cs.trials,
      delta: cs.passRate - bs.passRate,
      z,
      significant: Math.abs(z) >= zThreshold,
    });
  }
  return {
    baseline: baseline.harness,
    candidate: candidate.harness,
    zThreshold,
    cases,
    regressions: cases.filter((d) => d.significant && d.delta < 0),
    improvements: cases.filter((d) => d.significant && d.delta > 0),
  };
}
