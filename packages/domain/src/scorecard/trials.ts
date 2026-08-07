import { BadRequestError, type CaseResult, type Scorecard, type VerdictPolicy } from "@everdict/contracts";
import { caseVerdict } from "./scorecard.js";
import { DEFAULT_VERDICT_POLICY } from "./verdict-policy.js";

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
// pass-deciding grader is excluded, same rule as scorecardPassRate). The trials belong to ONE batch, so they
// are judged under THAT batch's policy — a caller comparing two batches passes each side its own.
export function caseTrialStats(
  caseId: string,
  results: CaseResult[],
  policy: VerdictPolicy = DEFAULT_VERDICT_POLICY,
): CaseTrialStats {
  let trials = 0;
  let passes = 0;
  for (const r of results) {
    const v = caseVerdict(r, policy);
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

// Scorecard-level trial roll-up. Cases are weighted equally (not by trial count). `k` defaults to
// maxTrials ("did any of k attempts pass"); pass@1 is always reported. `policy` is the batch's own — this
// roll-up is derived on READ, so a stamped batch must hand in its resolved policy or its historical pass@1
// silently moves with the ladder.
export function summarizeTrials(
  sc: Pick<Scorecard, "results">,
  opts: { k?: number; policy?: VerdictPolicy } = {},
): ScorecardTrialSummary {
  const k = opts.k;
  const policy = opts.policy ?? DEFAULT_VERDICT_POLICY;
  const stats = [...groupTrials(sc).entries()]
    .map(([caseId, results]) => caseTrialStats(caseId, results, policy))
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
  // Which test decided significance for THIS case: small samples (either side < FISHER_MAX_N trials) use
  // Fisher's exact test — the normal approximation behind z is unreliable at eval-scale trial counts (3–10)
  // and near 0/1 rates. p is the Fisher two-sided p-value when method is "fisher".
  method: "z" | "fisher";
  p?: number;
  significant: boolean; // statistically significant AND |delta| >= minDelta (practical threshold)
}

// Cases that could not enter the statistical gate — reported, never silently dropped.
export interface TrialDiffMissing {
  casesOnlyInBaseline: string[];
  casesOnlyInCandidate: string[];
  unscoredCases: string[]; // present on both sides but with no scored trials on at least one
}

export interface TrialDiff {
  baseline: string;
  candidate: string;
  zThreshold: number;
  minDelta: number; // practical-significance floor: a statistically significant drop below this is noise, not a gate
  cases: TrialCaseDelta[];
  regressions: TrialCaseDelta[]; // significant AND rate dropped
  improvements: TrialCaseDelta[]; // significant AND rate rose
  missing: TrialDiffMissing;
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

// Below this many trials on either side the z normal approximation is unreliable — use Fisher's exact test.
const FISHER_MAX_N = 30;

const logFactCache: number[] = [0];
function logFactorial(n: number): number {
  for (let i = logFactCache.length; i <= n; i++) {
    const prev = logFactCache[i - 1];
    if (prev === undefined) throw new BadRequestError("BAD_REQUEST", { n }, "logFactorial cache corrupted");
    logFactCache.push(prev + Math.log(i));
  }
  const v = logFactCache[n];
  if (v === undefined) throw new BadRequestError("BAD_REQUEST", { n }, "logFactorial expects n >= 0");
  return v;
}

// Fisher's exact test (two-sided) on the 2×2 table [[cb, nb-cb], [cc, nc-cc]] — the sum of probabilities of
// all tables (same margins) no more likely than the observed one. Exact at any n, unlike the z approximation.
export function fisherExactTwoSided(cb: number, nb: number, cc: number, nc: number): number {
  const row1 = nb;
  const row2 = nc;
  const col1 = cb + cc; // total passes
  const total = nb + nc;
  const logTable = (a: number): number =>
    logFactorial(row1) +
    logFactorial(row2) +
    logFactorial(col1) +
    logFactorial(total - col1) -
    (logFactorial(total) +
      logFactorial(a) +
      logFactorial(row1 - a) +
      logFactorial(col1 - a) +
      logFactorial(row2 - (col1 - a)));
  const lo = Math.max(0, col1 - row2);
  const hi = Math.min(row1, col1);
  const observed = logTable(cb);
  let p = 0;
  for (let a = lo; a <= hi; a++) {
    const lp = logTable(a);
    if (lp <= observed + 1e-9) p += Math.exp(lp);
  }
  return Math.min(1, p);
}

// The z threshold's two-sided alpha (e.g. 1.96 → ~0.05) so the Fisher branch gates at the same confidence.
function alphaForZ(zThreshold: number): number {
  // Φ(z) via the Abramowitz–Stegun erf approximation — plenty for mapping a gate threshold to its alpha.
  const t = 1 / (1 + 0.3275911 * (zThreshold / Math.SQRT2));
  const erf =
    1 -
    (0.254829592 * t - 0.284496736 * t ** 2 + 1.421413741 * t ** 3 - 1.453152027 * t ** 4 + 1.061405429 * t ** 5) *
      Math.exp(-((zThreshold / Math.SQRT2) ** 2));
  return 2 * (1 - (1 + erf) / 2);
}

// Statistical regression gate — baseline(vA) vs candidate(vB) over the same cases, run as trials.
// A case is a regression only when the pass-rate drop is BOTH statistically significant (Fisher exact under
// FISHER_MAX_N trials, else two-proportion z at zThreshold) AND practically significant (|delta| >= minDelta) —
// a significant-but-negligible 1% dip on a thousand trials is noise to a gate, and a 3/3→0/3 crash on three
// trials is honestly NOT significant at 95% (Fisher p=0.1): the gate says so instead of pretending. Cases that
// cannot enter the gate are enumerated in `missing`, never silently dropped.
// Each side's trials are judged under ITS OWN stamped policy (baselinePolicy/candidatePolicy): re-deriving a
// historical batch's pass rate under today's ladder is the retroactive rewrite the stamp exists to prevent,
// and it lands straight in a release gate's regression count. When the two policies differ the caller's
// comparability machinery flags the pair — the numbers here stay each side's own either way.
export function diffTrials(
  baseline: Scorecard,
  candidate: Scorecard,
  opts: {
    zThreshold?: number;
    minDelta?: number;
    baselinePolicy?: VerdictPolicy;
    candidatePolicy?: VerdictPolicy;
  } = {},
): TrialDiff {
  const zThreshold = opts.zThreshold ?? 1.96;
  const minDelta = opts.minDelta ?? 0;
  const alpha = alphaForZ(zThreshold);
  const b = groupTrials(baseline);
  const c = groupTrials(candidate);
  const cases: TrialCaseDelta[] = [];
  const missing: TrialDiffMissing = {
    casesOnlyInBaseline: [...b.keys()].filter((id) => !c.has(id)),
    casesOnlyInCandidate: [...c.keys()].filter((id) => !b.has(id)),
    unscoredCases: [],
  };
  for (const [caseId, cResults] of c) {
    const bResults = b.get(caseId);
    if (!bResults) continue; // enumerated in missing.casesOnlyInCandidate
    const bs = caseTrialStats(caseId, bResults, opts.baselinePolicy ?? DEFAULT_VERDICT_POLICY);
    const cs = caseTrialStats(caseId, cResults, opts.candidatePolicy ?? DEFAULT_VERDICT_POLICY);
    if (bs.trials === 0 || cs.trials === 0) {
      missing.unscoredCases.push(caseId);
      continue;
    }
    const z = twoProportionZ(bs.passes, bs.trials, cs.passes, cs.trials);
    const delta = cs.passRate - bs.passRate;
    const useFisher = bs.trials < FISHER_MAX_N || cs.trials < FISHER_MAX_N;
    const p = useFisher ? fisherExactTwoSided(bs.passes, bs.trials, cs.passes, cs.trials) : undefined;
    const statSignificant = useFisher ? (p ?? 1) < alpha : Math.abs(z) >= zThreshold;
    cases.push({
      caseId,
      baselineRate: bs.passRate,
      baselineTrials: bs.trials,
      candidateRate: cs.passRate,
      candidateTrials: cs.trials,
      delta,
      z,
      method: useFisher ? "fisher" : "z",
      ...(p !== undefined ? { p } : {}),
      significant: statSignificant && Math.abs(delta) >= minDelta,
    });
  }
  return {
    baseline: baseline.harness,
    candidate: candidate.harness,
    zThreshold,
    minDelta,
    cases,
    regressions: cases.filter((d) => d.significant && d.delta < 0),
    improvements: cases.filter((d) => d.significant && d.delta > 0),
    missing,
  };
}
