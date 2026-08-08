import type { ScorecardManifest } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { experimentIdentity } from "./experiment-identity.js";
import { evaluateGate } from "./gate.js";
import type { GateInput } from "./gate.js";

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
const sealed = (over: Partial<ScorecardManifest> = {}): ScorecardManifest => ({
  dataset: { id: "bench", version: "7.0.0", digest: "sha256:composite-a" },
  cases: { login: "sha256:case-login-a", search: "sha256:case-search-a" },
  grading: "sha256:grading-a",
  harness: { id: "agent", version: "1.0.0", specDigest: "sha256:hhhh" },
  ...over,
});

describe("experimentIdentity — held / confound / unverified, never a guess", () => {
  it("identical seals hold every axis — and the harness is deliberately not one (it is the treatment)", () => {
    const id = experimentIdentity(
      sealed({ harness: { id: "agent", version: "1.0.0" } }),
      sealed({ harness: { id: "agent", version: "2.0.0" } }), // the treatment moved — not a confound
    );
    expect(id.held).toEqual(["dataset_content", "grading_plan", "judge_set"]);
    expect(id.confounds).toEqual([]);
    expect(id.unverified).toEqual([]);
  });

  it("a SHARED case whose content changed is the dataset confound — and it names the case", () => {
    const id = experimentIdentity(
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
    const id = experimentIdentity(
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
    const id = experimentIdentity(sealed(), sealed({ grading: "sha256:grading-B" }));
    expect(id.confounds.map((c) => c.axis)).toEqual(["grading_plan"]);
    expect(id.held).toContain("dataset_content");
  });

  it("pre-split seals that DIFFER are unverifiable on the composite axes — never a confound, never held", () => {
    // Content, selection and grading moved indistinguishably inside one hash: claiming "different content"
    // would be as unfounded as claiming "same grading".
    const id = experimentIdentity(
      manifest(),
      manifest({ dataset: { id: "bench", version: "8.0.0", digest: "sha256:bbbb" } }),
    );
    expect(id.confounds).toEqual([]);
    expect(id.unverified.map((u) => `${u.axis}:${u.reason}`)).toEqual([
      "dataset_content:composite",
      "grading_plan:composite",
    ]);
    // …while EQUAL composites still verify held (identical everything), and a re-registered version label
    // over the same content is the same experiment.
    const relabeled = experimentIdentity(
      manifest(),
      manifest({ dataset: { id: "bench", version: "8.0.0", digest: "sha256:aaaa" } }),
    );
    expect(relabeled.held).toEqual(["dataset_content", "grading_plan", "judge_set"]);
  });

  it("one side running a grading-plan override while the other runs defaults is a confound (pre-split seals)", () => {
    const id = experimentIdentity(manifest({ graders: "sha256:gggg" }), manifest());
    expect(id.confounds.map((c) => c.axis)).toEqual(["grading_plan"]);
  });

  it("mixed seal generations cannot compare grading — unverified, not a guess", () => {
    const id = experimentIdentity(sealed(), manifest());
    expect(id.unverified.some((u) => u.axis === "grading_plan" && u.reason === "unsealed")).toBe(true);
  });

  it("a different judge selection — or the same selection with an edited document — is a confound", () => {
    const j = (id: string, version: string, specDigest?: string) => ({
      id,
      version,
      ...(specDigest ? { specDigest } : {}),
    });
    const selection = experimentIdentity(
      manifest({ judges: [j("quality", "1", "sha256:j1")] }),
      manifest({ judges: [j("style", "1", "sha256:j2")] }),
    );
    expect(selection.confounds.map((c) => c.axis)).toEqual(["judge_set"]);
    const edited = experimentIdentity(
      manifest({ judges: [j("quality", "1", "sha256:j1")] }),
      manifest({ judges: [j("quality", "1", "sha256:j1-edited")] }),
    );
    expect(edited.confounds[0]?.detail).toContain("same id@version, different judge");
    const unsealedJudge = experimentIdentity(
      manifest({ judges: [j("quality", "1")] }),
      manifest({ judges: [j("quality", "1", "sha256:j1")] }),
    );
    expect(unsealedJudge.unverified.map((u) => u.reason)).toEqual(["unsealed"]);
  });

  it("cross-era seals are UNVERIFIED, not a confound — FNV(x) and sha256(x) differ as strings over one document", () => {
    const id = experimentIdentity(
      manifest({ dataset: { id: "bench", version: "7.0.0", digest: "0123456789abcdef" } }), // legacy FNV
      manifest(),
    );
    expect(id.confounds).toEqual([]);
    // Both composite axes are unverifiable across the era gap: content AND the per-case grading defaults.
    expect(id.unverified.map((u) => u.reason)).toEqual(["digest_era", "digest_era"]);
  });

  it("an unsealed side verifies nothing — every axis unverified, none confounded", () => {
    const id = experimentIdentity(undefined, manifest());
    expect(id.held).toEqual([]);
    expect(id.confounds).toEqual([]);
    expect(id.unverified.map((u) => u.axis)).toEqual(["dataset_content", "grading_plan", "judge_set"]);
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
