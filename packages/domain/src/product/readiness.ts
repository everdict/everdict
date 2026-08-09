import type { GateScoringPin } from "@everdict/contracts";
import type {
  ProductRecord,
  ProductSeries,
  ReleaseReadiness,
  ReleaseRecord,
  ReleaseSeriesState,
  SeriesVerdict,
} from "@everdict/contracts";
import { contentDigest } from "../provenance/content-digest.js";

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
  // WHICH judgment this point is (arch-review 8 P1). A scorecard id alone is not an evidence reference: the
  // same id means different judgments after a re-score, so a decision recorded against the bare id cannot be
  // reproduced — and the next release's baseline, resolved by id, silently reads whatever the plane says now.
  scoring?: GateScoringPin;
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
  allowNoBaseline: boolean,
): { verdict: SeriesVerdict; reasons?: string[] } {
  if (latest === undefined) return { verdict: "not_evaluated", reasons: ["this series has no succeeded evaluation"] };
  // A FIRST ship has no prior anchor — true, and not the same sentence as "this is fine to ship". The old
  // reading made `no_baseline` unconditionally passing, so a required series whose only evidence was a batch
  // where every case infra-failed (a succeeded pipeline with nothing verdicted) shipped green: exactly the
  // "absence of evidence read as absence of regression" shape the verdict work set out to close, surviving
  // in the one lane nobody re-read. Shipping without a comparison is now a GOVERNANCE decision — the series
  // policy says `allowNoBaseline` — and even then the evidence has to contain a verdict.
  if (baseline === undefined) {
    if (!allowNoBaseline)
      return {
        verdict: "bootstrap_required",
        reasons: [
          "first ship of a required series — no baseline to compare against; approve it explicitly (allowNoBaseline) to ship on absolute evidence",
        ],
      };
    if (latest.passRate === undefined)
      return {
        verdict: "bootstrap_required",
        reasons: ["this series' only evaluation produced no verdict at all — there is nothing to ship on"],
      };
    return { verdict: "no_baseline" };
  }
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
    const { verdict, reasons } = seriesVerdict(
      latest,
      baseline,
      gateBySeries.get(entry.key),
      entry.allowNoBaseline === true,
    );
    // A series blocks when it is REQUIRED (the fail-closed default) and its verdict is not a passing one.
    // The explicit `requiredForRelease: false` is the only way evidence-less green exists — a recorded
    // product policy, never an inference.
    const required = entry.requiredForRelease !== false;
    const blocks = required && verdict !== "pass" && verdict !== "no_baseline";
    return {
      key: entry.key,
      label: entry.label,
      // Whether this series GATED the decision. Product policy is editable, so a live re-read cannot answer
      // it afterwards — the field existed but nothing filled it, which made the recorded decision silent
      // about the one thing that decides whether a non-pass verdict mattered.
      required,
      ...(latest !== undefined
        ? {
            latest: {
              scorecardId: latest.scorecardId,
              ...(latest.passRate !== undefined ? { passRate: latest.passRate } : {}),
              createdAt: latest.createdAt,
              ...(latest.serviceVersion !== undefined ? { serviceVersion: latest.serviceVersion } : {}),
              // WHICH judgment — dropping it here made the release decision record a scorecard id and call
              // it an evidence reference, which it stops being the moment a re-score lands.
              ...(latest.scoring !== undefined ? { scoring: latest.scoring } : {}),
            },
          }
        : {}),
      ...(baseline !== undefined
        ? {
            baseline: {
              scorecardId: baseline.scorecardId,
              ...(baseline.passRate !== undefined ? { passRate: baseline.passRate } : {}),
              createdAt: baseline.createdAt,
              ...(baseline.scoring !== undefined ? { scoring: baseline.scoring } : {}),
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

// The digest of the POLICY a release decision stood on — the watched series and, per series, whether it
// gated and whether a bootstrap was pre-approved. Series metadata that cannot change a verdict (labels,
// datasets) is deliberately out: a decision should read as "same policy" when only a label was edited.
// Deterministic (key-sorted) so two reads of an unchanged policy agree.
export function productPolicyDigest(product: Pick<ProductRecord, "series">): string {
  return contentDigest(
    [...product.series]
      .map((s) => ({
        key: s.key,
        required: s.requiredForRelease !== false,
        allowNoBaseline: s.allowNoBaseline === true,
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
  );
}
