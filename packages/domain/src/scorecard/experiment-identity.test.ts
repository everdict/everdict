import { MANIFEST_IDENTITY_VERSION, type ScorecardManifest } from "@everdict/contracts";
import type { CaseResult } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { EXPERIMENT_AXES, experimentIdentity } from "./experiment-identity.js";
import { evaluateGate } from "./gate.js";
import type { GateInput } from "./gate.js";
import { sealGrading } from "./scoring-plan.js";

// One shared, pinned world for the fixtures below. These cases are about the MANIFEST axes, so they pass a world that holds — an empty results pair would
// make every one of them report an unverifiable world too, which is true and is somebody else's test.
const SAME_WORLD = (() => {
  const ran = (caseId: string) =>
    ({
      caseId,
      harness: "agent@1.0.0",
      trace: [],
      snapshot: { kind: "prompt", output: "" },
      scores: [],
      execution: {
        os: "linux",
        osResolved: "declared",
        manifestVersion: 2,
        imageProvenance: { kind: "resolved", by: "driver", images: [{ ref: "img:1", digest: "sha256:img" }] },
      },
    }) as unknown as CaseResult;
  return { baseline: [ran("login")], candidate: [ran("login")] };
})();
const identity = (
  baseline: Parameters<typeof experimentIdentity>[0],
  candidate: Parameters<typeof experimentIdentity>[1],
) => experimentIdentity(baseline, candidate, SAME_WORLD);

// Experiment identity — the right to call a diff a regression. The manifest already seals what each batch
// evaluated; these pin that the seals are read AGAINST EACH OTHER: same-experiment axes verify held, a
// verified difference is a confound a gate refuses, and an unverifiable axis says so instead of guessing.

// A pre-split manifest — only the composite bundle digest (content × selection × grading in one hash).
const manifest = (over: Partial<ScorecardManifest> = {}): ScorecardManifest => ({
  dataset: { id: "bench", version: "7.0.0", digest: "sha256:aaaa" },
  harness: { id: "agent", version: "1.0.0", specDigest: "sha256:hhhh" },
  ...over,
});
// A split-seal manifest — per-case semantic digests + the effective-grading seal (the orthogonal axes).
// Declares its seal era (I8), exactly as production submit stamps it — an absent closure facet on this
// shape is a CLAIM of emptiness, not a generation gap.
const sealed = (over: Partial<ScorecardManifest> = {}): ScorecardManifest => ({
  identityVersion: MANIFEST_IDENTITY_VERSION,
  dataset: { id: "bench", version: "7.0.0", digest: "sha256:composite-a" },
  cases: { login: "sha256:case-login-a", search: "sha256:case-search-a" },
  grading: "sha256:grading-a",
  harness: { id: "agent", version: "1.0.0", specDigest: "sha256:hhhh" },
  ...over,
});

describe("experimentIdentity — held / confound / unverified, never a guess", () => {
  it("identical seals hold every axis — and the harness is deliberately not one (it is the treatment)", () => {
    const id = identity(
      sealed({ harness: { id: "agent", version: "1.0.0" } }),
      sealed({ harness: { id: "agent", version: "2.0.0" } }), // the treatment moved — not a confound
    );
    // Derived, not restated: "every axis" is a claim about the vocabulary, and a hand-copied list turns
    // "an axis was added" into a failure that says nothing about this test (rule `protocol` L3).
    expect([...id.held].sort()).toEqual([...EXPERIMENT_AXES].sort());
    expect(id.confounds).toEqual([]);
    expect(id.unverified).toEqual([]);
  });

  it("a SHARED case whose content changed is the dataset confound — and it names the case", () => {
    const id = identity(
      sealed(),
      sealed({
        dataset: { id: "bench", version: "8.0.0", digest: "sha256:composite-b" },
        cases: { login: "sha256:case-login-EDITED", search: "sha256:case-search-a" },
      }),
    );
    expect(id.confounds.map((c) => c.axis)).toEqual(["dataset_content"]);
    expect(id.confounds[0]?.detail).toContain("'login'");
    expect(id.confounds[0]?.detail).toContain("bench@7.0.0");
  });

  it("a SUBSET is coverage, never a dataset confound — one-sided cases are not this axis's business", () => {
    // The candidate ran only `login` (80-of-100 shape). Pre-split, the composite digest moved and the pair
    // was refused as "a different experiment" BEFORE the coverage machinery — with its own allow_partial
    // knobs — got a vote. The shared case verifies identical, so the axis holds.
    const id = identity(
      sealed(),
      sealed({
        dataset: { id: "bench", version: "7.0.0", digest: "sha256:composite-subset" },
        cases: { login: "sha256:case-login-a" },
      }),
    );
    expect(id.held).toContain("dataset_content");
    expect(id.confounds).toEqual([]);
  });

  it("a grading-only change confounds exactly ONE axis — the composite seal used to claim two", () => {
    const id = identity(sealed(), sealed({ grading: "sha256:grading-B" }));
    expect(id.confounds.map((c) => c.axis)).toEqual(["grading_plan"]);
    expect(id.held).toContain("dataset_content");
  });

  it("a SUBSET with identical defaults holds the grading axis — the selection-keyed composite made it a confound (H5)", () => {
    // PRODUCTION-DERIVED seals (sealGrading): the full run sealed two cases' defaults, the deliberate subset
    // sealed one. The shared case grades identically, so the axis holds — one-sided cases are coverage's
    // business. Pre-fix, the differing selection-keyed composites read as "the scoring apparatus differs".
    const graders = [{ id: "tests" }];
    const full = sealed(
      sealGrading(undefined, [
        { id: "login", graders },
        { id: "search", graders },
      ]),
    );
    const subset = sealed({
      cases: { login: "sha256:case-login-a" },
      ...sealGrading(undefined, [{ id: "login", graders }]),
    });
    const id = identity(full, subset);
    expect(id.confounds).toEqual([]);
    expect(id.held).toContain("grading_plan");
  });

  it("a SHARED case whose defaults changed is a verified grading confound — and it names the case", () => {
    const before = sealed(
      sealGrading(undefined, [
        { id: "login", graders: [{ id: "tests" }] },
        { id: "search", graders: [{ id: "tests" }] },
      ]),
    );
    const after = sealed(
      sealGrading(undefined, [
        { id: "login", graders: [{ id: "tests" }, { id: "lint" }] }, // the edit
        { id: "search", graders: [{ id: "tests" }] },
      ]),
    );
    const id = identity(before, after);
    expect(id.confounds.map((c) => c.axis)).toEqual(["grading_plan"]);
    expect(id.confounds[0]?.detail).toContain("'login'");
  });

  it("a split-era plan side against a defaults side is a verified apparatus confound", () => {
    const plan = sealed(sealGrading([{ id: "custom" }], []));
    const defaults = sealed(sealGrading(undefined, [{ id: "login", graders: [{ id: "tests" }] }]));
    const id = identity(plan, defaults);
    expect(id.confounds.map((c) => c.axis)).toEqual(["grading_plan"]);
    expect(id.confounds[0]?.detail).toContain("grading-plan override");
  });

  it("against a pre-gradingCases seal, a differing composite confounds ONLY over an identical selection — a subset stays unverifiable", () => {
    // The old record sealed only the selection-keyed composite. Same selection + differing composite can
    // only mean the defaults changed (verified confound); differing selections leave the edit and the
    // subset indistinguishable inside one hash (unverified "composite", never a guess).
    const oldFull = sealed({ grading: "sha256:defaults-old" }); // pre-H5: no gradingCases
    const newFull = sealed(
      sealGrading(undefined, [
        { id: "login", graders: [{ id: "tests" }] },
        { id: "search", graders: [{ id: "tests" }] },
      ]),
    );
    const sameSelection = identity(oldFull, newFull);
    expect(sameSelection.confounds.map((c) => c.axis)).toEqual(["grading_plan"]);
    expect(sameSelection.confounds[0]?.detail).toContain("identical selection");

    const newSubset = sealed({
      cases: { login: "sha256:case-login-a" },
      ...sealGrading(undefined, [{ id: "login", graders: [{ id: "tests" }] }]),
    });
    const subsetPair = identity(oldFull, newSubset);
    expect(subsetPair.confounds).toEqual([]);
    expect(subsetPair.unverified.some((u) => u.axis === "grading_plan" && u.reason === "composite")).toBe(true);
  });

  it("pre-split seals that DIFFER are unverifiable on the composite axes — never a confound, never held", () => {
    // Content, selection and grading moved indistinguishably inside one hash: claiming "different content"
    // would be as unfounded as claiming "same grading".
    const id = identity(manifest(), manifest({ dataset: { id: "bench", version: "8.0.0", digest: "sha256:bbbb" } }));
    expect(id.confounds).toEqual([]);
    expect(id.unverified.map((u) => `${u.axis}:${u.reason}`)).toEqual([
      "dataset_content:composite",
      "grading_plan:composite",
      "harness_model:unsealed", // a legacy pair's empty model closure is a generation gap, never a held claim (I8)
    ]);
    // …while EQUAL composites still verify held (identical everything), and a re-registered version label
    // over the same content is the same experiment. The harness MODEL closure stays unverified: neither
    // legacy side declared its seal era, so "no binding" and "pre-closure seal" are indistinguishable.
    const relabeled = identity(
      manifest(),
      manifest({ dataset: { id: "bench", version: "8.0.0", digest: "sha256:aaaa" } }),
    );
    expect(relabeled.held).toEqual(["dataset_content", "grading_plan", "judge_set", "execution_world"]);
    expect(relabeled.unverified.map((u) => `${u.axis}:${u.reason}`)).toEqual(["harness_model:unsealed"]);
  });

  it("one side running a grading-plan override while the other runs defaults is a confound (pre-split seals)", () => {
    const id = identity(manifest({ graders: "sha256:gggg" }), manifest());
    expect(id.confounds.map((c) => c.axis)).toEqual(["grading_plan"]);
  });

  it("mixed seal generations cannot compare grading — unverified, not a guess", () => {
    const id = identity(sealed(), manifest());
    expect(id.unverified.some((u) => u.axis === "grading_plan" && u.reason === "unsealed")).toBe(true);
  });

  it("a different judge selection — or the same selection with an edited document — is a confound", () => {
    const j = (id: string, version: string, specDigest?: string) => ({
      id,
      version,
      ...(specDigest ? { specDigest } : {}),
    });
    const selection = identity(
      manifest({ judges: [j("quality", "1", "sha256:j1")] }),
      manifest({ judges: [j("style", "1", "sha256:j2")] }),
    );
    expect(selection.confounds.map((c) => c.axis)).toEqual(["judge_set"]);
    const edited = identity(
      manifest({ judges: [j("quality", "1", "sha256:j1")] }),
      manifest({ judges: [j("quality", "1", "sha256:j1-edited")] }),
    );
    expect(edited.confounds[0]?.detail).toContain("same id@version, different judge");
    const unsealedJudge = identity(
      manifest({ judges: [j("quality", "1")] }),
      manifest({ judges: [j("quality", "1", "sha256:j1")] }),
    );
    expect(unsealedJudge.unverified.filter((u) => u.axis === "judge_set").map((u) => u.reason)).toEqual(["unsealed"]);
  });

  it("the judge CLOSURE decides, not just the document — same specDigest, different resolved model is a confound", () => {
    // A judge spec pinning {ref: "judge-default"} with no version is a byte-identical document over a moving
    // target: baseline sealed while latest was v5, candidate while latest was v6. The spec digests read held;
    // the sealed concrete models are the identity that actually judged.
    const j = (model?: string) => [
      { id: "quality", version: "1", specDigest: "sha256:j1", ...(model ? { model } : {}) },
    ];
    const moved = identity(sealed({ judges: j("judge-default@5.0.0") }), sealed({ judges: j("judge-default@6.0.0") }));
    expect(moved.confounds.map((c) => c.axis)).toEqual(["judge_set"]);
    expect(moved.confounds[0]?.detail).toContain("same document, different judge");
    const held = identity(sealed({ judges: j("judge-default@5.0.0") }), sealed({ judges: j("judge-default@5.0.0") }));
    expect(held.held).toContain("judge_set");
    // An unresolvable binding sealed the honest sentinel — unverifiable, never a sameness claim.
    const unresolved = identity(sealed({ judges: j("unresolved") }), sealed({ judges: j("unresolved") }));
    expect(unresolved.unverified.map((u) => u.axis)).toEqual(["judge_set"]);
  });

  it("the rubric and delegated-harness closures decide too — a latest ref resolving differently is a confound (H8)", () => {
    // A judge spec whose rubric is a {ref} (or whose verdict delegates to a harness at latest) is a
    // byte-identical document over TWO more moving targets — the model closure's exact shape, twice over.
    const j = (over: Record<string, string | undefined> = {}) => [
      { id: "quality", version: "3", specDigest: "sha256:same-doc", model: "m@1", ...over },
    ];
    const rubricMoved = identity(
      sealed({ judges: j({ rubric: "style@1.0.0" }) }),
      sealed({ judges: j({ rubric: "style@2.0.0" }) }),
    );
    expect(rubricMoved.confounds.map((c) => c.axis)).toEqual(["judge_set"]);
    expect(rubricMoved.confounds[0]?.detail).toContain("rubric closure differs");

    const harnessMoved = identity(
      sealed({ judges: j({ harness: "grader-agent@1.0.0" }) }),
      sealed({ judges: j({ harness: "grader-agent@2.0.0" }) }),
    );
    expect(harnessMoved.confounds[0]?.detail).toContain("delegated harness closure differs");

    // An unresolved seal is honest ignorance — unverifiable, never a sameness claim.
    const unresolved = identity(
      sealed({ judges: j({ rubric: "unresolved" }) }),
      sealed({ judges: j({ rubric: "unresolved" }) }),
    );
    expect(unresolved.unverified.map((u) => u.axis)).toEqual(["judge_set"]);

    // A pre-H8 side never sealed the closure — a seal-generation gap, not a shape difference (specDigests held).
    const crossGen = identity(sealed({ judges: j({ rubric: "style@1.0.0" }) }), sealed({ judges: j() }));
    expect(crossGen.confounds).toEqual([]);
    expect(crossGen.unverified.some((u) => u.axis === "judge_set" && u.reason === "unsealed")).toBe(true);

    // The whole closure held ⇒ the axis holds.
    const held = identity(
      sealed({ judges: j({ rubric: "style@1.0.0", harness: "grader-agent@1.0.0" }) }),
      sealed({ judges: j({ rubric: "style@1.0.0", harness: "grader-agent@1.0.0" }) }),
    );
    expect(held.held).toContain("judge_set");
  });

  it("the RUNTIME judge configuration is identity too — an inline judge under a different model confounds an identical judge list", () => {
    const differs = identity(
      sealed({ judgeRun: { model: "claude-opus-4-8" } }),
      sealed({ judgeRun: { model: "gpt-5.4" } }),
    );
    expect(differs.confounds.map((c) => c.axis)).toEqual(["judge_set"]);
    expect(differs.confounds[0]?.detail).toContain("runtime judge configuration");
    // One side judged under a config, the other under none — a verified apparatus difference.
    const oneSided = identity(sealed({ judgeRun: { model: "claude-opus-4-8" } }), sealed());
    expect(oneSided.confounds.map((c) => c.axis)).toEqual(["judge_set"]);
    // A pre-split side never sealed it: unverifiable, not a guess.
    const crossGen = identity(sealed({ judgeRun: { model: "claude-opus-4-8" } }), manifest());
    expect(crossGen.unverified.some((u) => u.axis === "judge_set" && u.reason === "unsealed")).toBe(true);
  });

  it("the harness MODEL closure confounds only under a HELD treatment (H13)", () => {
    // A harness binding's {ref} without a version resolves latest at dispatch — the judge-closure argument,
    // applied to the treatment itself. The axis speaks ONLY when the harness identity is held: a version
    // bump or an ephemeral-pin swap (different specDigest under one id@version) IS the treatment.
    const withModel = (model?: string): ScorecardManifest =>
      sealed({ harness: { id: "agent", version: "1.0.0", specDigest: "sha256:hhhh", ...(model ? { model } : {}) } });
    const moved = identity(withModel("x@5.0.0"), withModel("x@6.0.0"));
    expect(moved.confounds.map((c) => c.axis)).toEqual(["harness_model"]);
    expect(moved.confounds[0]?.detail).toContain("different executing model");

    // The treatment moved (a version bump) — closures differ, and the axis deliberately claims nothing.
    const treatment = identity(
      withModel("x@5.0.0"),
      sealed({ harness: { id: "agent", version: "2.0.0", specDigest: "sha256:h2", model: "x@6.0.0" } }),
    );
    expect(treatment.confounds).toEqual([]);
    expect(treatment.held).toContain("harness_model");

    // An ephemeral-pin swap: same id@version, different document — the pin IS the treatment in a PR eval.
    const pinSwap = identity(
      withModel("x@5.0.0"),
      sealed({ harness: { id: "agent", version: "1.0.0", specDigest: "sha256:PINNED", model: "x@6.0.0" } }),
    );
    expect(pinSwap.confounds).toEqual([]);

    // A one-sided seal is a seal-generation gap; an unresolved seal is honest ignorance — never sameness.
    const oneSided = identity(withModel("x@5.0.0"), withModel(undefined));
    expect(oneSided.confounds).toEqual([]);
    expect(oneSided.unverified.some((u) => u.axis === "harness_model" && u.reason === "unsealed")).toBe(true);
    const unresolved = identity(withModel("unresolved"), withModel("unresolved"));
    expect(unresolved.unverified.some((u) => u.axis === "harness_model")).toBe(true);

    // Both sides sealing nothing is held ONLY because both DECLARE their seal era (I8) — absence on a
    // stamped manifest is a claim of "no binding", not a generation gap.
    expect(identity(withModel(undefined), withModel(undefined)).held).toContain("harness_model");

    // A service harness's closure is per service, and the confound names the one that moved.
    const topo = (api: string): ScorecardManifest =>
      sealed({
        harness: {
          id: "topo",
          version: "1.0.0",
          specDigest: "sha256:t",
          serviceModels: { api, worker: "y@1.0.0" },
        },
      });
    const svcMoved = identity(topo("x@5.0.0"), topo("x@6.0.0"));
    expect(svcMoved.confounds.map((c) => c.axis)).toEqual(["harness_model"]);
    expect(svcMoved.confounds[0]?.detail).toContain("service 'api'");
  });

  it("cross-era seals are UNVERIFIED, not a confound — FNV(x) and sha256(x) differ as strings over one document", () => {
    const id = identity(
      manifest({ dataset: { id: "bench", version: "7.0.0", digest: "0123456789abcdef" } }), // legacy FNV
      manifest(),
    );
    expect(id.confounds).toEqual([]);
    // Both composite axes are unverifiable across the era gap: content AND the per-case grading defaults —
    // and the legacy pair's empty harness model closure is a generation gap of its own (I8).
    expect(id.unverified.map((u) => u.reason)).toEqual(["digest_era", "digest_era", "unsealed"]);
  });

  it("an unsealed side verifies nothing — every axis unverified, none confounded", () => {
    const id = identity(undefined, manifest());
    expect(id.held).toEqual([]);
    expect(id.confounds).toEqual([]);
    expect(id.unverified.map((u) => u.axis).sort()).toEqual([...EXPERIMENT_AXES].sort());
  });
});

describe("evaluateGate — a confounded pair cannot gate green", () => {
  const gateInput = (over: Partial<GateInput>): GateInput => ({
    baseline: "b",
    candidate: "c",
    metrics: [],
    regressions: [],
    improvements: [],
    caseTransitions: [],
    metricCoverage: [],
    missing: {
      casesOnlyInBaseline: [],
      casesOnlyInCandidate: [],
      metricsOnlyInBaseline: [],
      metricsOnlyInCandidate: [],
    },
    incomparable: [],
    overlap: { sharedCases: 3, baselineCases: 3, candidateCases: 3 },
    comparability: "full",
    ...over,
  });

  it("a verified confound refuses as not_comparable with NO verdict numbers — a different experiment", () => {
    const g = evaluateGate(
      gateInput({
        caseTransitions: [{ caseId: "x", baseline: true, candidate: false, change: "broke" }],
        experiment: {
          held: ["grading_plan", "judge_set"],
          confounds: [{ axis: "dataset_content", detail: "dataset content differs (bench@7.0.0 → bench@8.0.0)" }],
          unverified: [],
        },
      }),
      { maxRegressions: 0 },
    );
    expect(g.decision).toBe("not_comparable");
    expect(g.reasons[0]?.kind).toBe("confounded");
    expect(g.evidence.regressions).toBeUndefined(); // the numbers measure the apparatus — not computed
  });

  it("an acknowledged confound proceeds WITH the acknowledgment recorded — and each gap needs its own acknowledgment", () => {
    const experiment = {
      held: [],
      confounds: [{ axis: "dataset_content" as const, detail: "dataset content differs" }],
      unverified: [
        { axis: "judge_set" as const, reason: "unsealed" as const, detail: "judge quality@1 carries no spec digest" },
      ],
    };
    // Acknowledging the confound alone is not enough — the unverified axis still refuses.
    const half = evaluateGate(gateInput({ experiment }), { maxRegressions: 0, allowConfounds: ["dataset_content"] });
    expect(half.decision).toBe("not_comparable");
    expect(half.reasons[0]?.kind).toBe("identity_unverified");
    const acknowledged = evaluateGate(gateInput({ experiment }), {
      maxRegressions: 0,
      allowConfounds: ["dataset_content"],
      allowUnverifiedIdentity: true,
    });
    expect(acknowledged.decision).toBe("pass");
    expect(acknowledged.reasons.some((r) => r.kind === "confounded" && r.detail.includes("accepted"))).toBe(true);
    expect(acknowledged.reasons.some((r) => r.kind === "identity_unverified" && r.detail.includes("accepted"))).toBe(
      true,
    );
  });

  it("an unverifiable identity cannot gate green by DEFAULT — analytics may say 'unknown', a gate may not say 'green'", () => {
    // Regression: unverified axes used to inform and never refuse, so an unsealed-baseline vs sealed-candidate
    // pair with 0 regressions gated PASS while nothing proved the same dataset/grading/judges ever ran. The
    // gate now refuses like it refuses an unresolvable policy; the gap is acknowledgeable, and recorded.
    const unsealedPair = gateInput({
      experiment: {
        held: [],
        confounds: [],
        unverified: [
          { axis: "dataset_content", reason: "unsealed", detail: "both sides are unsealed" },
          { axis: "grading_plan", reason: "unsealed", detail: "both sides are unsealed" },
          { axis: "judge_set", reason: "unsealed", detail: "both sides are unsealed" },
        ],
      },
    });
    const refused = evaluateGate(unsealedPair, { maxRegressions: 0 });
    expect(refused.decision).toBe("not_comparable");
    expect(refused.reasons.filter((r) => r.kind === "identity_unverified")).toHaveLength(3);
    expect(refused.evidence.regressions).toBeUndefined(); // no verdict numbers on a refusal

    const acknowledged = evaluateGate(unsealedPair, { maxRegressions: 0, allowUnverifiedIdentity: true });
    expect(acknowledged.decision).toBe("pass");
    expect(acknowledged.reasons.filter((r) => r.kind === "identity_unverified")).toHaveLength(3);
  });
});

describe("experimentIdentity — the seal era is DECLARED, never inferred from absence (I8)", () => {
  it("a legacy pair's empty closures read unverified — 'no binding' and 'pre-closure seal' are indistinguishable", () => {
    // Pre-fix, two legacy manifests with empty model closures verified harness_model HELD ("same model
    // executed") over a facet nobody ever sealed — the exact era-inference lie the declared version removes.
    const id = identity(manifest(), manifest());
    expect(id.unverified.some((u) => u.axis === "harness_model" && u.reason === "unsealed")).toBe(true);
    expect(id.held).not.toContain("harness_model");
  });

  it("a judge whose closure is absent on a LEGACY pair is unverified; on a declared-era pair it is a held claim", () => {
    const judges = [{ id: "quality", version: "1", specDigest: "sha256:j1" }];
    // Legacy pair: same document, but no side declared its era — the absent model closure is a generation gap.
    const legacy = identity(manifest({ judges }), manifest({ judges }));
    expect(legacy.unverified.some((u) => u.axis === "judge_set" && u.reason === "unsealed")).toBe(true);
    // Declared-era pair: the same absence is a claim (a delegating judge carries no binding) — verified held.
    const declared = identity(sealed({ judges }), sealed({ judges }));
    expect(declared.held).toContain("judge_set");
  });

  it("mixed eras name the LEGACY side — the declared side's absence stays a claim", () => {
    const id = identity(manifest(), sealed());
    const row = id.unverified.find((u) => u.axis === "harness_model");
    expect(row?.reason).toBe("unsealed");
    expect(row?.detail).toContain("the baseline");
  });
});
