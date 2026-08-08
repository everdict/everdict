import type { ScorecardManifest } from "@everdict/contracts";

// Experiment identity — the right to call a diff a REGRESSION.
//
// A release comparison claims "same experiment, different treatment": the harness (the thing shipping) is
// the treatment axis, and everything else that decides the numbers — the dataset content, the grading plan,
// the judge documents — must be HELD CONSTANT, or the delta measures the drift of the apparatus rather than
// the product. The manifest already seals exactly those documents at submit (trust-kernel contract ⑤); this
// module is where the two seals are read AGAINST EACH OTHER, so "benchmark@7 under judge J1" vs
// "benchmark@8 under judge J2" stops reaching a release gate as a clean treatment comparison.
//
// Three answers per axis, never two: an axis is `held` (verified same), a `confound` (VERIFIED different —
// the gate refuses unless the caller acknowledges it), or `unverified` (nothing to verify with: an unsealed
// side, or stamps from different digest eras that cannot be compared — a claim of sameness would be as
// unfounded as a claim of difference, so it rides as information, not as a refusal). The verified/unverified
// split is the same shape checkpoint evidence uses (`verified | unverified_external`).
//
// The verdict policy is deliberately NOT an axis here — policy identity has its own owner
// (resolvePolicyResolution / policyMismatch / policyUnresolvable), and two owners for one invariant is how
// the answers drift apart.

export type ExperimentAxis = "dataset_content" | "grading_plan" | "judge_set";

export interface ExperimentConfound {
  axis: ExperimentAxis;
  detail: string;
}
export interface ExperimentUnverified {
  axis: ExperimentAxis;
  // "composite" = the side sealed only the COMPOSITE bundle digest (content × selection × grading in one
  // hash, pre-split manifests): a differing composite cannot say WHICH of the three moved, so the axis is
  // unverifiable rather than confounded — a subset run or a grading change must not read as a content claim.
  reason: "unsealed" | "digest_era" | "composite";
  detail: string;
}
export interface ExperimentIdentity {
  held: ExperimentAxis[];
  confounds: ExperimentConfound[];
  unverified: ExperimentUnverified[];
}

// Era detection mirrors content-digest.ts: sha256 stamps are prefixed, legacy FNV stamps are bare 16-hex.
// Two stamps VERIFY sameness (or difference) only under one algorithm — FNV(x) and sha256(x) differ as
// strings even when the documents are identical, so a cross-era pair is unverifiable, never a confound.
const era = (digest: string): "sha256" | "legacy" => (digest.startsWith("sha256:") ? "sha256" : "legacy");

type AxisReading =
  | { state: "held" }
  | { state: "confound"; detail: string }
  | { state: "unverified"; reason: ExperimentUnverified["reason"]; detail: string };

function compareStamps(what: string, baseline: string, candidate: string): AxisReading {
  if (era(baseline) !== era(candidate))
    return {
      state: "unverified",
      reason: "digest_era",
      detail: `${what}: the two seals use different digest algorithms (${era(baseline)} vs ${era(candidate)}) — sameness cannot be verified either way`,
    };
  if (baseline === candidate) return { state: "held" };
  return { state: "confound", detail: what };
}

// The dataset axis answers ONE question — are the SHARED cases the same cases? — from the per-case semantic
// digests. One-sided cases are deliberately not its business: a case the candidate never ran (a subset) or
// newly added is COVERAGE, first-class in `missing`/`metricCoverage`, and reading it as a content confound
// let a deliberate 80-of-100 run be refused as "a different experiment" before the coverage machinery — with
// its own allow_partial knobs — ever got a vote. A pre-split manifest sealed only the composite bundle
// digest: equal composites still verify held (identical everything), differing composites are UNVERIFIABLE
// on this axis (content, selection and grading moved indistinguishably), never a confound.
function datasetAxis(b: ScorecardManifest, c: ScorecardManifest): AxisReading {
  const label = (m: ScorecardManifest): string => `${m.dataset.id}@${m.dataset.version}`;
  if (b.cases !== undefined && c.cases !== undefined) {
    const shared = Object.keys(b.cases).filter((id) => c.cases !== undefined && id in c.cases);
    const differing: string[] = [];
    for (const id of shared) {
      const bd = b.cases[id];
      const cd = c.cases[id];
      if (bd === undefined || cd === undefined) continue;
      if (era(bd) !== era(cd))
        return {
          state: "unverified",
          reason: "digest_era",
          detail: `case '${id}' is sealed under different digest algorithms — sameness cannot be verified either way`,
        };
      if (bd !== cd) differing.push(id);
    }
    if (differing.length === 0) return { state: "held" }; // every shared case verified identical (one-sided cases are coverage's axis)
    const named = differing.slice(0, 3).join("', '");
    return {
      state: "confound",
      detail: `${differing.length} shared case(s) changed content between the sides ('${named}'${differing.length > 3 ? ` and ${differing.length - 3} more` : ""}) (${label(b)} → ${label(c)}) — the same case id no longer names the same task`,
    };
  }
  // Pre-split fallback: only the composite digest exists.
  if (era(b.dataset.digest) !== era(c.dataset.digest))
    return {
      state: "unverified",
      reason: "digest_era",
      detail: `dataset seals use different digest algorithms (${era(b.dataset.digest)} vs ${era(c.dataset.digest)}) — sameness cannot be verified either way`,
    };
  if (b.dataset.digest === c.dataset.digest) return { state: "held" };
  return {
    state: "unverified",
    reason: "composite",
    detail: `the sides sealed only composite bundle digests and they differ (${label(b)} → ${label(c)}) — content, selection and grading moved indistinguishably, so no content claim can be made either way`,
  };
}

// The grading axis reads the EFFECTIVE grading seal (the runtime plan, else the per-case defaults) when both
// sides carry one. Pre-split manifests sealed only a plan digest (absent = defaults): a plan-vs-plan or
// plan-vs-defaults difference is still a verified confound there, but defaults-vs-defaults can only be held
// when the composite bundle digests match — otherwise a default-grader edit hides, and claiming held would
// invent the very sameness this axis exists to verify.
function gradingPlanAxis(b: ScorecardManifest, c: ScorecardManifest): AxisReading {
  if (b.grading !== undefined && c.grading !== undefined) {
    return compareStamps(
      "the effective grading differs — the same trace would be scored differently",
      b.grading,
      c.grading,
    );
  }
  if (b.grading !== undefined || c.grading !== undefined)
    return {
      state: "unverified",
      reason: "unsealed",
      detail: `${b.grading === undefined ? "the baseline" : "the candidate"} predates the effective-grading seal — the grading semantics cannot be compared across seal generations`,
    };
  // Pre-split on both sides.
  if (b.graders === undefined && c.graders === undefined) {
    if (era(b.dataset.digest) !== era(c.dataset.digest))
      return {
        state: "unverified",
        reason: "digest_era",
        detail:
          "both sides ran per-case default graders and their composite seals use different digest algorithms — whether the defaults matched cannot be verified either way",
      };
    if (b.dataset.digest === c.dataset.digest) return { state: "held" }; // identical composite bundles ⇒ identical per-case defaults
    return {
      state: "unverified",
      reason: "composite",
      detail:
        "both sides ran per-case default graders under pre-split seals — whether the defaults matched is not verifiable from the composite digests",
    };
  }
  if (b.graders === undefined || c.graders === undefined)
    return {
      state: "confound",
      detail: `one side ran a grading-plan override and the other ran per-case defaults (${b.graders === undefined ? "baseline" : "candidate"} default) — the scoring apparatus differs`,
    };
  return compareStamps("the grading plan differs — the same trace would be scored differently", b.graders, c.graders);
}

function judgeSetAxis(b: ScorecardManifest, c: ScorecardManifest): AxisReading {
  // The RUNTIME judge configuration compares first — it applies to inline judge graders too, so an empty
  // (or identical) registered-judge selection does not exempt it. It is comparable only across split-seal
  // generations (`cases` marks one): a pre-split side never sealed it, and absence there is not "none".
  const bSplit = b.cases !== undefined;
  const cSplit = c.cases !== undefined;
  if (bSplit && cSplit) {
    if (b.judgeRun?.model === "unresolved" || c.judgeRun?.model === "unresolved")
      return {
        state: "unverified",
        reason: "unsealed",
        detail: "the runtime judge model could not be resolved at seal time — which model judged is unverifiable",
      };
    const runKey = (r: ScorecardManifest["judgeRun"]): string =>
      r === undefined ? "none" : `${r.provider ?? "default"}/${r.model}`;
    if (runKey(b.judgeRun) !== runKey(c.judgeRun))
      return {
        state: "confound",
        detail: `the runtime judge configuration differs (${runKey(b.judgeRun)} → ${runKey(c.judgeRun)}) — the same trace would be judged by a different model`,
      };
  } else if (b.judgeRun !== undefined || c.judgeRun !== undefined) {
    return {
      state: "unverified",
      reason: "unsealed",
      detail:
        "a pre-split side never sealed its runtime judge configuration — whether the same model judged cannot be verified",
    };
  }
  const bs = [...(b.judges ?? [])].sort((x, y) => (x.id < y.id ? -1 : 1));
  const cs = [...(c.judges ?? [])].sort((x, y) => (x.id < y.id ? -1 : 1));
  if (bs.length === 0 && cs.length === 0) return { state: "held" };
  const name = (j: { id: string; version: string }): string => `${j.id}@${j.version}`;
  const selection = (js: typeof bs): string => js.map(name).join(", ");
  if (selection(bs) !== selection(cs))
    return {
      state: "confound",
      detail: `the judge selection differs ([${selection(bs) || "none"}] vs [${selection(cs) || "none"}]) — different judges produced the judge scores`,
    };
  // Same selection — verify the DOCUMENTS (an edited judge under the same version is a different judge),
  // then the CLOSURE: the spec digest pins bytes, and a nested `{ref}` with no version pins a moving
  // target, so the concrete model the binding resolved to at seal time is part of the judge's identity.
  for (const [i, bj] of bs.entries()) {
    const cj = cs[i];
    if (bj.specDigest === undefined || cj?.specDigest === undefined)
      return {
        state: "unverified",
        reason: "unsealed",
        detail: `judge ${name(bj)} carries no spec digest on ${bj.specDigest === undefined ? "the baseline" : "the candidate"} — same id@version, but the documents cannot be verified identical`,
      };
    const read = compareStamps(
      `judge ${name(bj)}'s document differs between the sides — same id@version, different judge`,
      bj.specDigest,
      cj.specDigest,
    );
    if (read.state !== "held") return read;
    if (bj.model === "unresolved" || cj.model === "unresolved")
      return {
        state: "unverified",
        reason: "unsealed",
        detail: `judge ${name(bj)}'s model binding could not be resolved at seal time — which concrete model judged is unverifiable`,
      };
    if (bj.model !== cj.model) {
      if (bj.model !== undefined && cj.model !== undefined)
        return {
          state: "confound",
          detail: `judge ${name(bj)} resolved different concrete models (${bj.model} → ${cj.model}) — same document, different judge`,
        };
      return {
        state: "unverified",
        reason: "unsealed",
        detail: `judge ${name(bj)}'s resolved model is sealed on only one side — whether the same model judged cannot be verified`,
      };
    }
  }
  return { state: "held" };
}

// The identity read. An entirely unsealed side (pre-manifest batch, mig 0126) verifies NOTHING: every axis
// is unverified — which downgrades the claim a gate may make, without rewriting history as a refusal.
export function experimentIdentity(
  baseline: ScorecardManifest | undefined,
  candidate: ScorecardManifest | undefined,
): ExperimentIdentity {
  const axes: ExperimentAxis[] = ["dataset_content", "grading_plan", "judge_set"];
  if (baseline === undefined || candidate === undefined) {
    const sides =
      baseline === undefined && candidate === undefined
        ? "both sides are"
        : baseline === undefined
          ? "the baseline is"
          : "the candidate is";
    return {
      held: [],
      confounds: [],
      unverified: axes.map((axis) => ({
        axis,
        reason: "unsealed",
        detail: `${sides} unsealed (no reproducibility manifest) — nothing to verify the ${axis.replace("_", " ")} against`,
      })),
    };
  }
  const readings: Array<[ExperimentAxis, AxisReading]> = [
    ["dataset_content", datasetAxis(baseline, candidate)],
    ["grading_plan", gradingPlanAxis(baseline, candidate)],
    ["judge_set", judgeSetAxis(baseline, candidate)],
  ];
  const out: ExperimentIdentity = { held: [], confounds: [], unverified: [] };
  for (const [axis, reading] of readings) {
    if (reading.state === "held") out.held.push(axis);
    else if (reading.state === "confound") out.confounds.push({ axis, detail: reading.detail });
    else out.unverified.push({ axis, reason: reading.reason, detail: reading.detail });
  }
  return out;
}
