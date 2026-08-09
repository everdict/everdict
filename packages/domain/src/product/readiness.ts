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
export function watchedSeries(product: ProductRecord, release?: ReleaseScope): ProductSeries[] {
  return resolveWatchedSeries(product, release).series;
}

// What a release watches, and — separately — what it PROMISED to watch and can no longer find
// (arch-review 12 P0). The old shape returned a bare array built by `filter`, which meant a promised series
// that had been deleted from the product simply was not in it: no error, no gate, `regressedSeries: []`,
// `ready: true`. Deleting a series was a way to turn a red release green, sitting underneath every invariant
// built on top of it — and no CAS could catch it, because the decision reads the new product correctly and
// the new product is the one missing its gate.
//
// The scope is the release's FROZEN promise (`plannedSeriesKeys`) when it has one:
//   · explicit — exactly the keys it named. A key that vanished is `missing`.
//   · all      — everything the product declared at plan time, PLUS anything added since (more gates is never
//                the unsafe direction). A key that vanished is still `missing`.
// A release planned before the freeze existed has no promise to check, so it degrades to the live product
// series — honest, and it is the only reading available for it.
export interface ReleaseScope {
  seriesKeys?: string[];
  plannedSeriesKeys?: string[];
  seriesSelection?: "all" | "explicit";
}

export interface WatchedSeriesResolution {
  series: ProductSeries[];
  // Keys this release committed to that the product no longer declares. Never empty-and-ignored: the caller
  // turns each into a BLOCKING `scope_invalid` state.
  missing: string[];
}

export function resolveWatchedSeries(product: ProductRecord, release?: ReleaseScope): WatchedSeriesResolution {
  const declared = new Map(product.series.map((s) => [s.key, s] as const));
  const promised = release?.plannedSeriesKeys;
  if (promised !== undefined) {
    const missing = promised.filter((key) => !declared.has(key));
    // `all` keeps watching series added after the plan; `explicit` watches exactly what it named.
    const keys =
      release?.seriesSelection === "explicit"
        ? promised
        : [...new Set([...promised, ...product.series.map((s) => s.key)])];
    const series = keys.flatMap((key) => {
      const found = declared.get(key);
      return found ? [found] : [];
    });
    return { series, missing };
  }
  // No frozen promise (pre-freeze release). The live selection is all we have.
  const keys = release?.seriesKeys;
  if (keys === undefined) return { series: [...product.series], missing: [] };
  return {
    series: product.series.filter((s) => keys.includes(s.key)),
    // Even without a freeze, a LIVE selection naming a series the product no longer has is the same fault —
    // the release still said which axes judge it. This is what protects releases planned before the freeze.
    missing: keys.filter((key) => !declared.has(key)),
  };
}

// The EVALUATION CONTRACT a watch series declares — what it asks, as opposed to what it is called
// (arch-review 13 P0).
//
// A `ProductSeries` carries two unrelated things under one key. `key` is the TREND's identity, deliberately
// stable so relabeling never re-keys history. `{dataset, harness, judges}` is the CONTRACT — the question
// being asked. Release readiness selected evidence by the first and then treated it as evidence for the
// second: "the newest succeeded scorecard stamped `quality`" is not "the newest scorecard that evaluated what
// `quality` currently means", and editing the series to a new dataset left yesterday's green standing as
// today's evidence.
//
// The refs must be RESOLVED before digesting. A version-less ref means "latest at run time", so the product
// row need not change at all for the contract underneath it to move — which is why no CAS and no policy
// digest could ever catch this. The caller resolves (it owns the registries); this function only says what
// identity means, so the submit side and the readiness side cannot drift into two answers.
export interface ResolvedSeriesContract {
  dataset: { id: string; version: string };
  harness: { id: string; version: string };
  judges: Array<{ id: string; version: string }>;
}

export function seriesContractDigest(contract: ResolvedSeriesContract): string {
  return contentDigest({
    dataset: contract.dataset,
    harness: contract.harness,
    // Judge SELECTION is a set, not a sequence — the order a caller happens to list them in is not a
    // different question, and letting it be one would make every reorder look like a contract change.
    judges: [...contract.judges].sort((a, b) => a.id.localeCompare(b.id) || a.version.localeCompare(b.version)),
  });
}

// One scorecard's contribution to a series trend — the caller resolves which record is "latest" and which is
// the baseline (the service anchors the baseline at the previous released release; the domain does not care).
export interface SeriesScorecardPoint {
  scorecardId: string;
  passRate?: number;
  createdAt: string;
  serviceVersion?: string;
  // The contract this batch evaluated under (`origin.seriesContractDigest`). Absent = it predates the stamp
  // or its contract could not be resolved — evidence whose question cannot be named.
  contractDigest?: string;
  // WHICH judgment this point is (arch-review 8 P1). A scorecard id alone is not an evidence reference: the
  // same id means different judgments after a re-score, so a decision recorded against the bare id cannot be
  // reproduced — and the next release's baseline, resolved by id, silently reads whatever the plane says now.
  scoring?: GateScoringPin;
}

// WHY this series has (or has not) a baseline — four different facts that `baseline: undefined` used to
// collapse into one (arch-review 10 P0).
//
// The collapse was not cosmetic. `allowNoBaseline` is a governance decision meaning "this product has never
// shipped this series, and we approve shipping on absolute evidence" — and it was applied to EVERY absent
// baseline. So a series whose previous ship pinned a scorecard that has since been DELETED resolved to
// `baseline: undefined`, was read as "first ship", and shipped green. Losing the evidence of what we last
// shipped against made the gate weaker, which is precisely backwards: the absence of history is a reason to
// refuse, not a reason to skip the comparison.
//
// The application layer resolves which of these holds (it owns the stores); the domain decides what each one
// means. Only `none_first_ship` is a bootstrap question at all.
export type BaselineResolution =
  // Nothing to compare against because nothing was ever shipped. The genuine first-ship state, and the ONLY
  // one `allowNoBaseline` speaks to.
  | { kind: "none_first_ship" }
  // The previous ship's own candidate, found and readable — the comparison stands on the exact evidence that
  // ship stood on.
  | { kind: "resolved"; point: SeriesScorecardPoint }
  // A previous ship pinned a scorecard and that scorecard is GONE. History existed and we lost it; a
  // different scorecard is not a substitute, and no policy flag converts this into a bootstrap.
  | { kind: "missing_historical_evidence"; pin: GateScoringPin | undefined; scorecardId: string }
  // The pinned scorecard is still here but has been RE-SCORED since: the judgment the last ship compared
  // against is no longer the one a comparison would read. Addressable only once scoring planes are immutable
  // revisions (docs/architecture/scoring-plane-revisions.md).
  | { kind: "revision_unavailable"; pin: GateScoringPin; current: GateScoringPin; scorecardId: string };

// The SCORECARD GATE's decision over (baseline, latest) for one series — computed by the application layer
// (analytics.diff + evaluateGate, the SAME machinery a CI release gate runs) and handed in. The product
// layer never invents truth semantics: pass-rate arithmetic bypassed experiment identity, policy identity,
// scoring revisions, coverage, criticals, trials and FDR — the trust kernel existed and the release
// decision walked around it (arch-review 7 §2-3: "the weakest release path is the real guarantee").
export interface SeriesGateReading {
  verdict: Extract<SeriesVerdict, "pass" | "block" | "blocked_missing" | "not_comparable">;
  reasons?: string[];
  // The pins the GATE ITSELF read (arch-review 10 P0). The release used to record the pins it saw in the
  // trend LIST and the verdict it got from a LATER diff — two reads of the same records, so a re-score
  // landing between them stamped the decision with a revision that did not produce the verdict recorded
  // beside it. The gate already captures both sides at its one read (ComparisonSnapshot); carrying them here
  // means the decision records what it DECIDED ON rather than what it looked up first.
  //
  // Absent = a gate seam that predates this (or a unit fake); the readiness then falls back to the list pins
  // and is honestly degraded rather than silently wrong.
  baselineScoring?: GateScoringPin;
  candidateScoring?: GateScoringPin;
}

// A series' release verdict. NOT EVALUATED IS NEVER GREEN: a required series with no run blocks the ship —
// the pre-verdict arithmetic read "absence of evidence as not regressed", which made the product readiness a
// second, weaker release constitution underneath the scorecard gate. Opting a series out of the gate is the
// EXPLICIT `requiredForRelease: false` policy, never an inference from missing evidence. `no_baseline` is
// the first ship's honest state: evidence exists, but no prior ship anchors a regression question.
function seriesVerdict(
  latest: SeriesScorecardPoint | undefined,
  baseline: BaselineResolution,
  gate: SeriesGateReading | undefined,
  allowNoBaseline: boolean,
  // The contract this series declares NOW. Absent = the deployment cannot resolve it (no registry seam), in
  // which case the check abstains rather than blocking everything — an unenforceable invariant we can name
  // beats one we made up.
  contract?: string,
): { verdict: SeriesVerdict; reasons?: string[] } {
  if (latest === undefined) return { verdict: "not_evaluated", reasons: ["this series has no succeeded evaluation"] };
  // THE QUESTION CHANGED (arch-review 13 P0). Evidence stamped with a different contract answered a
  // different question; a scorecard whose contract is unstamped cannot say which question it answered at
  // all. Neither is evidence for the series as it stands, and reading either as current is how an edit to
  // the dataset silently kept yesterday's green.
  if (contract !== undefined && latest.contractDigest !== contract) {
    return {
      verdict: "contract_stale",
      reasons: [
        latest.contractDigest === undefined
          ? `this series' newest evaluation does not record which dataset/harness/judges it ran under, so it cannot be shown to answer the question this series asks now — re-run it`
          : `this series' newest evaluation ran under a different dataset/harness/judge selection than the series declares now — the question changed, so this is an answer to a different one; re-run it`,
      ],
    };
  }
  // LOST HISTORY IS NOT A BOOTSTRAP (arch-review 10 P0). These two branches used to be indistinguishable from
  // the first-ship one, which meant `allowNoBaseline` — an approval to ship the FIRST time — silently
  // licensed shipping after the evidence of the last ship disappeared. A pre-approval cannot cover a
  // condition it was never shown; both refuse regardless of policy, and no flag opens them.
  if (baseline.kind === "missing_historical_evidence")
    return {
      verdict: "not_comparable",
      reasons: [
        `the scorecard this product last shipped this series against (${baseline.scorecardId}) is no longer available — refusing to substitute a different one, and an absent history is not a first ship`,
      ],
    };
  if (baseline.kind === "revision_unavailable")
    return {
      verdict: "not_comparable",
      reasons: [
        `the baseline scorecard has been re-scored since the last ship (shipped against revision ${baseline.pin.revision}, now revision ${baseline.current.revision}) — the judgment this product shipped against is no longer the one a comparison would read`,
      ],
    };
  // A FIRST ship has no prior anchor — true, and not the same sentence as "this is fine to ship". The old
  // reading made `no_baseline` unconditionally passing, so a required series whose only evidence was a batch
  // where every case infra-failed (a succeeded pipeline with nothing verdicted) shipped green: exactly the
  // "absence of evidence read as absence of regression" shape the verdict work set out to close, surviving
  // in the one lane nobody re-read. Shipping without a comparison is now a GOVERNANCE decision — the series
  // policy says `allowNoBaseline` — and even then the evidence has to contain a verdict.
  if (baseline.kind === "none_first_ship") {
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
  // WHY each series has (or lacks) a baseline — not merely whether. A key with no entry is read as the
  // first-ship state, the same default the map's absence always meant.
  baselineBySeries: ReadonlyMap<string, BaselineResolution>,
  gateBySeries: ReadonlyMap<string, SeriesGateReading>,
  openIssues: number,
  // The CONTRACT each series declares now, resolved (arch-review 13 P0). Absent map / absent key = the
  // deployment cannot resolve it, and the freshness check abstains for that series.
  contractBySeries?: ReadonlyMap<string, string>,
): ReleaseReadiness {
  const resolution = resolveWatchedSeries(product, release);
  // A gate this release PROMISED and can no longer find blocks unconditionally (arch-review 12 P0). It is
  // not a measurement state, so it does not consult `requiredForRelease` — that flag lives on the series
  // declaration, and the declaration is the thing that disappeared. Reading a deleted gate as "optional"
  // would let the same edit that removed the gate also decide it never mattered.
  const missingScope: ReleaseSeriesState[] = resolution.missing.map((key) => ({
    key,
    label: key,
    required: true,
    verdict: "scope_invalid" as const,
    reasons: [
      `this release is judged on the "${key}" series and the product no longer declares it — the gate was removed, not passed; restore the series or re-plan this release's scope`,
    ],
    regressed: true,
  }));
  const series: ReleaseSeriesState[] = resolution.series.map((entry) => {
    const latest = latestBySeries.get(entry.key);
    const resolution = baselineBySeries.get(entry.key) ?? { kind: "none_first_ship" as const };
    const gate = gateBySeries.get(entry.key);
    const baseline = resolution.kind === "resolved" ? resolution.point : undefined;
    const { verdict, reasons } = seriesVerdict(
      latest,
      resolution,
      gate,
      entry.allowNoBaseline === true,
      contractBySeries?.get(entry.key),
    );
    // The pins RECORDED are the gate's own, never the trend list's, whenever the gate ran — see
    // SeriesGateReading. Falling back to the list pin is correct exactly where no gate ran (not_evaluated,
    // first ship): there is no second read to disagree with.
    const candidateScoring = gate?.candidateScoring ?? latest?.scoring;
    const baselineScoring = gate?.baselineScoring ?? baseline?.scoring;
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
              ...(candidateScoring !== undefined ? { scoring: candidateScoring } : {}),
            },
          }
        : {}),
      ...(baseline !== undefined
        ? {
            baseline: {
              scorecardId: baseline.scorecardId,
              ...(baseline.passRate !== undefined ? { passRate: baseline.passRate } : {}),
              createdAt: baseline.createdAt,
              ...(baselineScoring !== undefined ? { scoring: baselineScoring } : {}),
            },
          }
        : {}),
      verdict,
      ...(reasons?.length ? { reasons } : {}),
      regressed: blocks,
    };
  });
  const all = [...missingScope, ...series];
  const regressedSeries = all.filter((entry) => entry.regressed).map((entry) => entry.key);
  return {
    openIssues,
    series: all,
    regressedSeries,
    ready: openIssues === 0 && regressedSeries.length === 0,
  };
}

// The POLICY a release decision stood on, as a DOCUMENT (arch-review 10 P0). The decision used to record
// only a digest, and a digest of a mutable record is a one-way check: it can tell you the policy changed, and
// it can never tell you what the policy WAS. A ship whose product has since been edited then has an audit
// trail reading "these series gated" with no way to recover which, or whether a bootstrap had been
// pre-approved — the exact question a regression post-mortem asks first.
//
// Scoped to the WATCHED series, not the product's whole declaration: a decision stands on the policy of the
// series it actually evaluated, and digesting the others made an edit to a series this release never watched
// read as a policy change to this release's decision.
export interface ReleasePolicySeries {
  key: string;
  required: boolean;
  allowNoBaseline: boolean;
}

export function releasePolicyDocument(
  product: ProductRecord,
  // The FULL scope, not just `seriesKeys` (arch-review 13). `watchedSeries` now reads the frozen promise, so
  // a signature admitting only the live selection was a type-level lie: it said "this is enough to compute
  // the policy correctly", and a caller who believed it would silently fall back to the legacy derivation and
  // build a policy document for a scope the release never committed to.
  release?: ReleaseScope,
): ReleasePolicySeries[] {
  return watchedSeries(product, release)
    .map((s) => ({
      key: s.key,
      required: s.requiredForRelease !== false,
      allowNoBaseline: s.allowNoBaseline === true,
    }))
    .sort((a, b) => a.key.localeCompare(b.key)); // deterministic — two reads of an unchanged policy agree
}

// The digest of that document. Series metadata that cannot change a verdict (labels, datasets) is
// deliberately out: a decision should read as "same policy" when only a label was edited.
export function productPolicyDigest(product: ProductRecord, release?: ReleaseScope): string {
  return contentDigest(releasePolicyDocument(product, release));
}

// The digest of a product's ENTIRE release policy — every series' `{key, required, allowNoBaseline}`,
// independent of any one release (arch-review 12 follow-up).
//
// This is what a ship decision commits against, replacing the product's aggregate VERSION. The version was a
// conservative first guess and it conflated three concerns in one counter: content revision, release-policy
// revision, and sync-state revision. Every write bumped it — including `markServiceSynced`, whose own contract
// says it is bookkeeping and moves neither history nor `updatedAt`. So once the 15-minute sweep joined the CAS
// constitution, a background watermark write could conflict an in-flight ship that its policy had nothing to
// do with. A guard that refuses for reasons an operator cannot connect to the decision is a guard that gets
// worked around, and that is a trust risk of its own.
//
// Product-wide rather than per-release on purpose: it has to be a single stored value the WRITE STATEMENT can
// compare (the guard is an EXISTS on the product row — it cannot run a per-release computation), and the
// over-block it keeps is narrow and honest: editing a series this release does not watch. Renames, icons,
// descriptions, service edits and sync watermarks no longer conflict anything.
export function productReleasePolicyDigest(product: Pick<ProductRecord, "series">): string {
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
