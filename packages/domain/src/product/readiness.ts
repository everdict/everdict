import type {
  ProductRecord,
  ProductSeries,
  ReleaseReadiness,
  ReleaseRecord,
  ReleaseSeriesState,
  SeriesVerdict,
} from "@everdict/contracts";

// Release readiness is PURE arithmetic over what the caller already fetched — no store, no I/O (the tracker's
// readiness rule). The caller picks the scorecard points; the domain decides what they mean.

// The series a release actually watches: its own selection when it made one, else every series the product
// declares. Order is the product's declaration order — that is the display order everywhere.
export function watchedSeries(product: ProductRecord, release?: Pick<ReleaseRecord, "seriesKeys">): ProductSeries[] {
  const keys = release?.seriesKeys;
  if (keys === undefined) return [...product.series];
  return product.series.filter((series) => keys.includes(series.key));
}

// One scorecard's contribution to a series trend — the caller resolves which record is "latest" and which is
// the baseline (the service anchors the baseline at the previous released release; the domain does not care).
export interface SeriesScorecardPoint {
  scorecardId: string;
  passRate?: number;
  createdAt: string;
  serviceVersion?: string;
}

// The SCORECARD GATE's decision over (baseline, latest) for one series — computed by the application layer
// (analytics.diff + evaluateGate, the SAME machinery a CI release gate runs) and handed in. The product
// layer never invents truth semantics: pass-rate arithmetic bypassed experiment identity, policy identity,
// scoring revisions, coverage, criticals, trials and FDR — the trust kernel existed and the release
// decision walked around it (arch-review 7 §2-3: "the weakest release path is the real guarantee").
export interface SeriesGateReading {
  verdict: Extract<SeriesVerdict, "pass" | "block" | "blocked_missing" | "not_comparable">;
  reasons?: string[];
}

// A series' release verdict. NOT EVALUATED IS NEVER GREEN: a required series with no run blocks the ship —
// the pre-verdict arithmetic read "absence of evidence as not regressed", which made the product readiness a
// second, weaker release constitution underneath the scorecard gate. Opting a series out of the gate is the
// EXPLICIT `requiredForRelease: false` policy, never an inference from missing evidence. `no_baseline` is
// the first ship's honest state: evidence exists, but no prior ship anchors a regression question.
function seriesVerdict(
  latest: SeriesScorecardPoint | undefined,
  baseline: SeriesScorecardPoint | undefined,
  gate: SeriesGateReading | undefined,
): { verdict: SeriesVerdict; reasons?: string[] } {
  if (latest === undefined) return { verdict: "not_evaluated", reasons: ["this series has no succeeded evaluation"] };
  if (baseline === undefined) return { verdict: "no_baseline" };
  if (gate === undefined)
    return {
      verdict: "not_comparable",
      reasons: ["the release gate seam is not configured — refusing to guess a comparison"],
    };
  return { verdict: gate.verdict, ...(gate.reasons?.length ? { reasons: gate.reasons } : {}) };
}

export function releaseReadiness(
  release: ReleaseRecord,
  product: ProductRecord,
  latestBySeries: ReadonlyMap<string, SeriesScorecardPoint>,
  baselineBySeries: ReadonlyMap<string, SeriesScorecardPoint>,
  gateBySeries: ReadonlyMap<string, SeriesGateReading>,
  openIssues: number,
): ReleaseReadiness {
  const series: ReleaseSeriesState[] = watchedSeries(product, release).map((entry) => {
    const latest = latestBySeries.get(entry.key);
    const baseline = baselineBySeries.get(entry.key);
    const { verdict, reasons } = seriesVerdict(latest, baseline, gateBySeries.get(entry.key));
    // A series blocks when it is REQUIRED (the fail-closed default) and its verdict is not a passing one.
    // The explicit `requiredForRelease: false` is the only way evidence-less green exists — a recorded
    // product policy, never an inference.
    const required = entry.requiredForRelease !== false;
    const blocks = required && verdict !== "pass" && verdict !== "no_baseline";
    return {
      key: entry.key,
      label: entry.label,
      ...(latest !== undefined
        ? {
            latest: {
              scorecardId: latest.scorecardId,
              ...(latest.passRate !== undefined ? { passRate: latest.passRate } : {}),
              createdAt: latest.createdAt,
              ...(latest.serviceVersion !== undefined ? { serviceVersion: latest.serviceVersion } : {}),
            },
          }
        : {}),
      ...(baseline !== undefined
        ? {
            baseline: {
              scorecardId: baseline.scorecardId,
              ...(baseline.passRate !== undefined ? { passRate: baseline.passRate } : {}),
              createdAt: baseline.createdAt,
            },
          }
        : {}),
      verdict,
      ...(reasons?.length ? { reasons } : {}),
      regressed: blocks,
    };
  });
  const regressedSeries = series.filter((entry) => entry.regressed).map((entry) => entry.key);
  return {
    openIssues,
    series,
    regressedSeries,
    ready: openIssues === 0 && regressedSeries.length === 0,
  };
}
