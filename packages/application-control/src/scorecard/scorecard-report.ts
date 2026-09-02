import { BadRequestError, type Dataset, NotFoundError, type ScorecardRecord, isMeasured } from "@everdict/contracts";
import { caseVerdict, ownedByVisibleTeam, summarizeScorecard } from "@everdict/domain";
import { ExecutionPlan } from "./execution-plan.js";

// ── EXPORT WHAT IS CITABLE, REFUSE WHAT IS NOT (docs/architecture/benchmark-evidence-spec.md §4) ──────
//
// `official | proxy` said whether a number may be compared with the benchmark's own; nothing produced the
// comparison. This is the citable report: the number with everything that makes it a number — the dataset version
// and its digest, the harness version and its digest, the manifest, the scoring semantics as data — and it
// REFUSES a `proxy` (or unstated) scoring unless the caller asked for it by name, in which case the header says so.
// A number that is not the benchmark's number is exported saying so, or not at all.
export interface CitableReport {
  kind: "everdict-scorecard-report";
  exportedAt: string;
  scorecard: { id: string; createdAt: string; status: string };
  benchmark: {
    dataset: { id: string; version: string; digest?: string };
    scoring: {
      kind: "official" | "proxy" | "unstated";
      approximates?: string;
      officialEvaluator?: string;
      license?: string;
    };
    origin?: Dataset["producedBy"] extends infer P ? (P extends { origin?: infer O } ? O : never) : never;
  };
  harness: { id: string; version: string; specDigest?: string };
  manifest?: { identityVersion?: number; grading?: string };
  summary: ReturnType<typeof summarizeScorecard>;
  // The case's verdict under the batch's own policy — `unmeasured` when no authority decided it (never a false).
  cases: Array<{
    caseId: string;
    trial?: number;
    verdict: "pass" | "fail" | "unmeasured";
    scores: Array<{ metric: string; value: number }>;
  }>;
}

export interface CitableReportDeps {
  scorecards: { get(id: string): Promise<ScorecardRecord | undefined> };
  datasets: { get(tenant: string, id: string, ref?: string): Promise<Dataset> };
}

export async function citableReport(
  deps: CitableReportDeps,
  tenant: string,
  id: string,
  visibleTeams: string[] | undefined,
  opts: { allowProxy: boolean; now?: () => string },
): Promise<CitableReport> {
  const record = await deps.scorecards.get(id);
  if (!record || record.tenant !== tenant || !ownedByVisibleTeam(record, visibleTeams))
    throw new NotFoundError("NOT_FOUND", { id }, `scorecard '${id}' not found.`);
  if (record.status !== "succeeded")
    throw new BadRequestError(
      "BAD_REQUEST",
      { id, status: record.status },
      `scorecard '${id}' is ${record.status} — only a succeeded batch has a number to cite`,
    );
  const dataset = await deps.datasets.get(tenant, record.dataset.id, record.dataset.version);
  const declared = dataset.producedBy?.scoring;
  const scoring =
    declared === undefined
      ? { kind: "unstated" as const }
      : {
          kind: declared.kind,
          ...(declared.approximates !== undefined ? { approximates: declared.approximates } : {}),
          ...(declared.officialEvaluator !== undefined ? { officialEvaluator: declared.officialEvaluator } : {}),
          ...(declared.license !== undefined ? { license: declared.license } : {}),
        };
  if (scoring.kind !== "official" && !opts.allowProxy)
    throw new BadRequestError(
      "BAD_REQUEST",
      { id, scoring: scoring.kind },
      scoring.kind === "proxy"
        ? `this scorecard's dataset scores as a PROXY${scoring.approximates !== undefined ? ` — ${scoring.approximates}` : ""}; its number is not the benchmark's number. Pass allowProxy to export it labelled as such`
        : "this scorecard's dataset states no scoring semantics, so nothing here is citable as the benchmark's number. Pass allowProxy to export it labelled unstated",
    );
  const results = record.scorecard?.results ?? [];
  const sc = record.scorecard;
  // The sealed facets this citation quotes, read through the ONE owner of sealed reads (TRUST-120). A
  // report that re-read `manifest.*` itself would be the fifth spelling of four facets.
  const cited = ExecutionPlan.of(record).citation;

  return {
    kind: "everdict-scorecard-report",
    exportedAt: (opts.now ?? (() => new Date().toISOString()))(),
    scorecard: { id: record.id, createdAt: record.createdAt, status: record.status },
    benchmark: {
      dataset: {
        id: record.dataset.id,
        version: record.dataset.version,
        ...(cited.datasetDigest !== undefined ? { digest: cited.datasetDigest } : {}),
      },
      scoring,
      ...(dataset.producedBy?.origin !== undefined ? { origin: dataset.producedBy.origin } : {}),
    },
    harness: {
      id: record.harness.id,
      version: record.harness.version,
      ...(cited.harnessSpecDigest !== undefined ? { specDigest: cited.harnessSpecDigest } : {}),
    },
    ...(cited.identityVersion !== undefined || cited.grading !== undefined
      ? {
          manifest: {
            ...(cited.identityVersion !== undefined ? { identityVersion: cited.identityVersion } : {}),
            ...(cited.grading !== undefined ? { grading: cited.grading } : {}),
          },
        }
      : {}),
    summary: sc !== undefined ? summarizeScorecard(sc) : (record.summary ?? []),
    cases: results.map((r) => ({
      caseId: r.caseId,
      ...(r.trial !== undefined ? { trial: r.trial } : {}),
      verdict: ((decided) => (decided === undefined ? "unmeasured" : decided ? "pass" : "fail"))(caseVerdict(r)),
      scores: r.scores.filter(isMeasured).map((s) => ({ metric: s.metric, value: s.value })),
    })),
  };
}
