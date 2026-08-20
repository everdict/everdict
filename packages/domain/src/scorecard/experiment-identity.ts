import { type CaseResult, EXPERIMENT_AXES, type ExperimentAxis, type ScorecardManifest } from "@everdict/contracts";
import { imageProvenanceOf, sameResolvedImages } from "../image/image-provenance.js";

// Experiment identity — the right to call a diff a REGRESSION.
//
// A release comparison claims "same experiment, different treatment": the harness (the thing shipping) is
// the treatment axis, and everything else that decides the numbers — the dataset content, the grading plan,
// the judge documents — must be HELD CONSTANT, or the delta measures the drift of the apparatus rather than
// the product. The manifest already seals exactly those documents at submit (trust-kernel contract ⑤); this
// module is where the two seals are read AGAINST EACH OTHER, so "benchmark@7 under judge J1" vs
// "benchmark@8 under judge J2" stops reaching a release gate as a clean treatment comparison.
//
// The harness IDENTITY stays the treatment — but its MODEL CLOSURE is an axis (harness_model, H13): a
// harness binding's `{ref}` without a version resolves latest at dispatch, so the same harness id@version
// with a held specDigest can execute under a different model. When the comparison claims a HELD harness
// (same id@version, same document), that drift is apparatus, not treatment — the exact argument the judge
// closure already won. When the harness itself moved, the axis claims nothing (the delta IS the treatment).
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

// The axis vocabulary is OWNED BY CONTRACTS (`EXPERIMENT_AXES`) — it was hand-spelled in eight places, and
// adding `execution_world` is what made that cost concrete: every copy had to learn the value or silently
// reject a caller who used it (rule `protocol` L3). Re-exported here so this module stays the readable home
// of what the axes MEAN, without being a second declaration of what they ARE.
export { EXPERIMENT_AXES, type ExperimentAxis };

export interface ExperimentConfound {
  axis: ExperimentAxis;
  detail: string;
}
export interface ExperimentUnverified {
  axis: ExperimentAxis;
  // "composite" = the side sealed only the COMPOSITE bundle digest (content × selection × grading in one
  // hash, pre-split manifests): a differing composite cannot say WHICH of the three moved, so the axis is
  // unverifiable rather than confounded — a subset run or a grading change must not read as a content claim.
  // "unresolved" = the side ran, and could not say from WHICH bytes (a legacy-era manifest, an unpinned
  // tag, a verifier receipt that cannot name its container). Distinct from "unsealed", which is a side that
  // recorded no manifest at all.
  reason: "unsealed" | "digest_era" | "composite" | "unresolved";
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

// The DECLARED seal era (I8, MANIFEST_IDENTITY_VERSION): a stamped manifest claims every current facet was
// sealed, so an absent closure facet on it is a claim of emptiness. A legacy pair (either side unstamped)
// keeps absence ambiguous — "old seal generation" and "genuinely empty" read identically — so a both-absent
// closure there is UNVERIFIED, never a silent held.
const eraDeclared = (m: ScorecardManifest): boolean => m.identityVersion !== undefined;
const legacySide = (b: ScorecardManifest, c: ScorecardManifest): string =>
  !eraDeclared(b) && !eraDeclared(c) ? "both sides" : eraDeclared(b) ? "the candidate" : "the baseline";

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
// sides carry one. Like the dataset axis, it answers ONE question — do the SHARED cases grade the same way?
// — from the per-case grading digests (`gradingCases`): one-sided cases are coverage's axis, and the
// selection-keyed defaults composite alone made a deliberate 80/100 subset read as a grading confound (H5).
// Pre-gradingCases defaults seals can still verify held when the composites match; differing composites are
// UNVERIFIABLE (selection and defaults moved indistinguishably), never a confound. Pre-split manifests
// sealed only a plan digest (absent = defaults): a plan-vs-plan or plan-vs-defaults difference is still a
// verified confound there, but defaults-vs-defaults can only be held when the composite bundle digests match
// — otherwise a default-grader edit hides, and claiming held would invent the very sameness this axis
// exists to verify.
function gradingPlanAxis(b: ScorecardManifest, c: ScorecardManifest): AxisReading {
  if (b.grading !== undefined && c.grading !== undefined) {
    // `graders` doubles as the plan marker on a split-seal side (a plan run stamps both; defaults stamp neither).
    const bPlan = b.graders !== undefined;
    const cPlan = c.graders !== undefined;
    if (bPlan !== cPlan)
      return {
        state: "confound",
        detail: `one side ran a grading-plan override and the other ran per-case defaults (${bPlan ? "candidate" : "baseline"} default) — the scoring apparatus differs`,
      };
    if (bPlan)
      return compareStamps(
        "the grading plan differs — the same trace would be scored differently",
        b.grading,
        c.grading,
      );
    // Both sides ran per-case defaults. The per-case seals compare SHARED cases only.
    if (b.gradingCases !== undefined && c.gradingCases !== undefined) {
      const differing: string[] = [];
      for (const id of Object.keys(b.gradingCases)) {
        const bd = b.gradingCases[id];
        const cd = c.gradingCases[id];
        if (bd === undefined || cd === undefined) continue; // one-sided case — coverage's axis, not grading's
        if (era(bd) !== era(cd))
          return {
            state: "unverified",
            reason: "digest_era",
            detail: `case '${id}'s default graders are sealed under different digest algorithms — sameness cannot be verified either way`,
          };
        if (bd !== cd) differing.push(id);
      }
      if (differing.length === 0) return { state: "held" };
      const named = differing.slice(0, 3).join("', '");
      return {
        state: "confound",
        detail: `${differing.length} shared case(s) grade differently between the sides ('${named}'${differing.length > 3 ? ` and ${differing.length - 3} more` : ""}) — the same trace would be scored differently`,
      };
    }
    // At least one side predates the per-case grading seal. The composite is keyed by the SELECTION, so it
    // can still speak precisely when the selection is verifiably identical (the sealed case-id sets match):
    // a differing composite over one selection IS a defaults change. Over differing selections, a subset
    // and a default-grader edit are indistinguishable inside the one hash.
    if (era(b.grading) !== era(c.grading))
      return {
        state: "unverified",
        reason: "digest_era",
        detail:
          "both sides ran per-case default graders and their effective-grading seals use different digest algorithms — sameness cannot be verified either way",
      };
    if (b.grading === c.grading) return { state: "held" };
    const sameSelection =
      b.cases !== undefined &&
      c.cases !== undefined &&
      Object.keys(b.cases).length === Object.keys(c.cases).length &&
      Object.keys(b.cases).every((id) => c.cases !== undefined && id in c.cases);
    if (sameSelection)
      return {
        state: "confound",
        detail:
          "the per-case default graders differ over a verifiably identical selection — the same trace would be scored differently",
      };
    return {
      state: "unverified",
      reason: "composite",
      detail:
        "both sides ran per-case default graders and at least one sealed only the selection-keyed composite — a subset selection and a default-grader edit are indistinguishable, so no grading claim can be made either way",
    };
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
  const bSplit = eraDeclared(b) || b.cases !== undefined;
  const cSplit = eraDeclared(c) || c.cases !== undefined;
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
    // Both sides absent: on a DECLARED-era pair that is a claim (no binding — a delegating judge); on a
    // legacy pair it is indistinguishable from a pre-closure seal, so it reads unverified (I8).
    if (bj.model === undefined && cj.model === undefined && !(eraDeclared(b) && eraDeclared(c)))
      return {
        state: "unverified",
        reason: "unsealed",
        detail: `judge ${name(bj)}'s model closure predates the declared identity era on ${legacySide(b, c)} — an absent seal cannot be told from an unsealed one`,
      };
    // The REST of the closure (H8): a rubric REF and a delegated harness resolve at run time exactly like
    // the model binding, so byte-identical specs can judge under different rubric documents or delegate to
    // different agents. Held specDigests mean identical spec SHAPES — a one-sided seal can only be a
    // seal-generation gap, never a shape difference, so it reads unverified rather than confounded.
    const closures: Array<[string, string | undefined, string | undefined]> = [
      ["rubric", bj.rubric, cj.rubric],
      ["delegated harness", bj.harness, cj.harness],
    ];
    for (const [what, bv, cv] of closures) {
      if (bv === "unresolved" || cv === "unresolved")
        return {
          state: "unverified",
          reason: "unsealed",
          detail: `judge ${name(bj)}'s ${what} could not be resolved at seal time — which ${what} judged is unverifiable`,
        };
      if (bv === undefined && cv === undefined && !(eraDeclared(b) && eraDeclared(c)))
        return {
          state: "unverified",
          reason: "unsealed",
          detail: `judge ${name(bj)}'s ${what} closure predates the declared identity era on ${legacySide(b, c)} — an absent seal cannot be told from an unsealed one`,
        };
      if (bv !== cv) {
        if (bv !== undefined && cv !== undefined)
          return {
            state: "confound",
            detail: `judge ${name(bj)}'s ${what} closure differs (${bv} → ${cv}) — same document, different judging apparatus`,
          };
        return {
          state: "unverified",
          reason: "unsealed",
          detail: `judge ${name(bj)}'s ${what} is sealed on only one side — whether the same ${what} judged cannot be verified`,
        };
      }
    }
  }
  return { state: "held" };
}

// The harness MODEL closure axis (H13). Applies only under a HELD treatment — same harness id@version AND
// the same document (equal specDigests, or both absent for a built-in): an ephemeral-pin swap changes the
// spec bytes under one id@version, and a pin swap IS the treatment in a PR eval. Under a held treatment the
// sealed closures compare exactly like the judges': both sides sealing nothing is held (no binding, or two
// pre-closure seals — the judge-closure compat precedent), a one-sided seal is a seal-generation gap
// (unverified), "unresolved" is honest ignorance (unverified), and a verified difference is a confound —
// the same trace-producing run was executed by a different underlying model.
function harnessModelAxis(b: ScorecardManifest, c: ScorecardManifest): AxisReading {
  const treatmentHeld =
    b.harness.id === c.harness.id &&
    b.harness.version === c.harness.version &&
    b.harness.specDigest === c.harness.specDigest;
  if (!treatmentHeld) return { state: "held" }; // the delta IS the treatment — no under-the-treatment claim applies
  const sealedOf = (m: ScorecardManifest): Record<string, string> => ({
    ...(m.harness.model !== undefined ? { "": m.harness.model } : {}),
    ...(m.harness.serviceModels ?? {}),
  });
  const bs = sealedOf(b);
  const cs = sealedOf(c);
  const bEmpty = Object.keys(bs).length === 0;
  const cEmpty = Object.keys(cs).length === 0;
  if (bEmpty && cEmpty) {
    // A DECLARED-era pair sealing nothing genuinely has no binding to drift. A legacy pair reading the same
    // way was the era-inference lie (I8): "two pre-closure seals" and "no binding" were indistinguishable,
    // and the axis claimed HELD ("same model executed") over a facet nobody ever sealed.
    if (eraDeclared(b) && eraDeclared(c)) return { state: "held" };
    return {
      state: "unverified",
      reason: "unsealed",
      detail: `the harness model closure predates the declared identity era on ${legacySide(b, c)} — an absent seal cannot be told from an unsealed one`,
    };
  }
  if (bEmpty || cEmpty)
    return {
      state: "unverified",
      reason: "unsealed",
      detail: `${bEmpty ? "the baseline" : "the candidate"} predates the harness model-closure seal — whether the same model executed cannot be verified`,
    };
  for (const key of new Set([...Object.keys(bs), ...Object.keys(cs)])) {
    const label = key === "" ? "the harness model" : `service '${key}'s model`;
    const bv = bs[key];
    const cv = cs[key];
    if (bv === "unresolved" || cv === "unresolved")
      return {
        state: "unverified",
        reason: "unsealed",
        detail: `${label} binding could not be resolved at seal time — which concrete model executed is unverifiable`,
      };
    if (bv === undefined || cv === undefined)
      return {
        state: "unverified",
        reason: "unsealed",
        detail: `${label} is sealed on only one side — whether the same model executed cannot be verified`,
      };
    if (bv !== cv)
      return {
        state: "confound",
        detail: `${label} resolved differently (${bv} → ${cv}) under a HELD harness ${b.harness.id}@${b.harness.version} — same harness document, different executing model`,
      };
  }
  return { state: "held" };
}

// ── DID THESE TWO RUNS HAPPEN IN THE SAME WORLD? ────────────────────────────────────────────────────
//
// Read from the RESULTS rather than the manifest, because that is where the answer lives: each case records
// which image bytes it ran from (`ExecutionManifest.imageProvenance`, via `imageProvenanceOf` so a legacy
// manifest reports itself as unresolved rather than as nothing), and a case judged in a second container
// records whether that container could be named (`VerifierReceipt.complete`).
//
// Only SHARED cases are compared. A case one side never ran is missingness, which the diff reports on its
// own axis; reading it here would make every subset run a world confound.
//
// Order matters: UNVERIFIED wins over CONFOUND. If any compared case cannot say what it ran, the pair does
// not know whether it is looking at a difference or at its own ignorance, and "we cannot tell" must not be
// upgraded into "they differ" any more than into "they match".
// `undefined` = ABSTAIN. Not a fourth answer for the union — a claim this pair's records cannot support at
// all, so the axis says nothing rather than saying "unverified".
//
// The distinction is a rollout one and it is deliberate. The gate REFUSES an unverified axis by default, so
// an axis that read `unverified` whenever both sides were silent would retroactively block every comparison
// made before lanes recorded image provenance — including `POST /scorecards/ingest`, which scores traces
// from somebody else's runtime and has no world to record by construction. Those pairs are exactly as
// verifiable as they were yesterday; a new axis must not change the answer for data that did not change.
//
// So this axis speaks when the records give it something to speak about: a side that pinned its bytes, or a
// side that recorded an execution and could not. When every compared case on both sides is silent, it
// abstains — and when the lanes all record provenance, the silence stops happening and the abstention
// stops with it.
function worldAxis(baseline: readonly CaseResult[], candidate: readonly CaseResult[]): AxisReading | undefined {
  const byCase = new Map(candidate.map((r) => [r.caseId, r]));
  const shared = baseline.flatMap((b) => {
    const c = byCase.get(b.caseId);
    return c ? [[b, c] as const] : [];
  });
  // No shared case is missingness, which the diff reports on its own axis — this one has nothing to say.
  if (shared.length === 0) return undefined;

  // Nothing on either side records what it ran from: see the note above for why that is an abstention
  // rather than an unverifiable claim.
  if (
    shared.every(
      ([b, c]) =>
        b.execution === undefined && c.execution === undefined && b.verifier === undefined && c.verifier === undefined,
    )
  )
    return undefined;

  const differences: string[] = [];
  for (const [b, c] of shared) {
    // The DECIDING half first: a verdict produced in a container the lane could not name is unattributable
    // however well the agent's half pinned its image.
    for (const [side, r] of [
      ["baseline", b],
      ["candidate", c],
    ] as const)
      if (r.verifier !== undefined && !r.verifier.complete)
        return {
          state: "unverified",
          reason: "unresolved",
          detail: `case ${r.caseId}'s verdict came from a verifier container the ${side} lane could not name (an incomplete receipt), so the world its verdict was reached in is unknown`,
        };

    const bp = b.execution ? imageProvenanceOf(b.execution) : undefined;
    const cp = c.execution ? imageProvenanceOf(c.execution) : undefined;
    if (bp === undefined || cp === undefined)
      return {
        state: "unverified",
        reason: "unsealed",
        detail: `case ${b.caseId} recorded no execution manifest on ${bp === undefined ? "the baseline" : "the candidate"}, so nothing states which bytes it ran`,
      };
    if (bp.kind !== "resolved" || cp.kind !== "resolved")
      return {
        state: "unverified",
        reason: "unresolved",
        detail: `case ${b.caseId} could not pin the image it ran from on ${bp.kind !== "resolved" ? "the baseline" : "the candidate"} (${bp.kind !== "resolved" ? bp.kind : cp.kind}), so sameness cannot be verified either way`,
      };
    if (!sameResolvedImages(bp, cp)) differences.push(b.caseId);
  }
  if (differences.length > 0)
    return {
      state: "confound",
      detail: `${differences.length} compared case(s) ran different image bytes on the two sides (${differences
        .slice(0, 5)
        .join(
          ", ",
        )}${differences.length > 5 ? ", …" : ""}) — a delta across different worlds is not evidence about the change under test`,
    };
  return { state: "held" };
}

// The identity read. An entirely unsealed side (pre-manifest batch, mig 0126) verifies NOTHING: every axis
// is unverified — which downgrades the claim a gate may make, without rewriting history as a refusal.
export function experimentIdentity(
  baseline: ScorecardManifest | undefined,
  candidate: ScorecardManifest | undefined,
  // The two sides' RESULTS, for the axes a manifest cannot answer. Required, not optional: an optional
  // parameter here is the shape rule `protocol` L1 names — a caller that forgets it type checks, and the
  // axis silently reports `held` over worlds nobody compared.
  results: { baseline: readonly CaseResult[]; candidate: readonly CaseResult[] },
): ExperimentIdentity {
  const axes: readonly ExperimentAxis[] = EXPERIMENT_AXES;
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
  const world = worldAxis(results.baseline, results.candidate);
  const readings: Array<[ExperimentAxis, AxisReading]> = [
    ["dataset_content", datasetAxis(baseline, candidate)],
    ["grading_plan", gradingPlanAxis(baseline, candidate)],
    ["judge_set", judgeSetAxis(baseline, candidate)],
    ["harness_model", harnessModelAxis(baseline, candidate)],
    // Omitted entirely when the pair's records say nothing about the world — an abstention, not a verdict.
    ...(world ? ([["execution_world", world]] as Array<[ExperimentAxis, AxisReading]>) : []),
  ];
  const out: ExperimentIdentity = { held: [], confounds: [], unverified: [] };
  for (const [axis, reading] of readings) {
    if (reading.state === "held") out.held.push(axis);
    else if (reading.state === "confound") out.confounds.push({ axis, detail: reading.detail });
    else out.unverified.push({ axis, reason: reading.reason, detail: reading.detail });
  }
  return out;
}
