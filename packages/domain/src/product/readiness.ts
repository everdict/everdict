import type {
  ProductRecord,
  ProductSeries,
  ReleaseReadiness,
  ReleaseRecord,
  ReleaseSeriesState,
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

// Arithmetic, never inference: regressed = both rates measured AND the latest fell below the baseline.
// Anything unmeasured reads as NOT regressed — absence of evidence is not a regression, and a gate that
// blocked on a series that simply has not run yet would make every new series a release blocker.
function seriesRegressed(
  latest: SeriesScorecardPoint | undefined,
  baseline: SeriesScorecardPoint | undefined,
): boolean {
  if (latest?.passRate === undefined || baseline?.passRate === undefined) return false;
  return latest.passRate < baseline.passRate;
}

export function releaseReadiness(
  release: ReleaseRecord,
  product: ProductRecord,
  latestBySeries: ReadonlyMap<string, SeriesScorecardPoint>,
  baselineBySeries: ReadonlyMap<string, SeriesScorecardPoint>,
  openIssues: number,
): ReleaseReadiness {
  const series: ReleaseSeriesState[] = watchedSeries(product, release).map((entry) => {
    const latest = latestBySeries.get(entry.key);
    const baseline = baselineBySeries.get(entry.key);
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
      regressed: seriesRegressed(latest, baseline),
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
