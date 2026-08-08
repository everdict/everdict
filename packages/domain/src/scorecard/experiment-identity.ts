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
  reason: "unsealed" | "digest_era";
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
  | { state: "unverified"; reason: "unsealed" | "digest_era"; detail: string };

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

function datasetAxis(b: ScorecardManifest, c: ScorecardManifest): AxisReading {
  const label = (m: ScorecardManifest): string => `${m.dataset.id}@${m.dataset.version}`;
  return compareStamps(
    `dataset content differs (${label(b)} → ${label(c)}) — the cases under comparison are not the same cases`,
    b.dataset.digest,
    c.dataset.digest,
  );
}

function gradingPlanAxis(b: ScorecardManifest, c: ScorecardManifest): AxisReading {
  if (b.graders === undefined && c.graders === undefined) return { state: "held" }; // per-case defaults on both
  if (b.graders === undefined || c.graders === undefined)
    return {
      state: "confound",
      detail: `one side ran a grading-plan override and the other ran per-case defaults (${b.graders === undefined ? "baseline" : "candidate"} default) — the scoring apparatus differs`,
    };
  return compareStamps("the grading plan differs — the same trace would be scored differently", b.graders, c.graders);
}

function judgeSetAxis(b: ScorecardManifest, c: ScorecardManifest): AxisReading {
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
  // Same selection — verify the DOCUMENTS (an edited judge under the same version is a different judge).
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
