import type { CaseResult, Scorecard, ScorecardManifest } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { experimentIdentity } from "./experiment-identity.js";
import { evaluateGate } from "./gate.js";
import { diffScorecards } from "./scorecard.js";

// Trust suite (docs/trust-certification.md) — TRUST-21 / TRUST-22 / TRUST-25 / TRUST-26 / TRUST-27 / TRUST-30.
//
// TRUST-21: A CONFOUNDED PAIR CANNOT GATE GREEN. The manifests seal the held-constant documents (dataset
// content, grading plan, judge specs); a VERIFIED difference on any of them means the delta measures the
// apparatus, not the treatment — a different experiment. The gate refuses it as not_comparable unless the
// caller acknowledges the axis (allowConfounds), and the acknowledgment is recorded on the decision. The
// full production chain runs here: experimentIdentity over real manifests → diffScorecards → evaluateGate —
// stubbing any stage would certify an agreement the stages were never asked to have.
//
// TRUST-22: A REFUSAL CARRIES NO VERDICT NUMBERS. A not_comparable decision (confound, unresolvable stamp,
// comparability none) must not present regression/improvement counts — numbers nobody had the right to
// derive were persisted into GateDecisions next to the refusal that says exactly that.
const describeTrust = process.env.EVERDICT_TRUST_SUITE === "1" ? describe : describe.skip;

const result = (caseId: string, pass: boolean): CaseResult => ({
  caseId,
  harness: "h@1",
  trace: [],
  snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
  scores: [{ graderId: "tests", metric: "tests_pass", value: pass ? 1 : 0, pass }],
});
const card = (results: CaseResult[]): Scorecard => ({ suiteId: "s", harness: "h@1", results });
// Split-seal manifests: the dataset axis reads per-case SEMANTIC digests, so a differing shared case is a
// VERIFIED confound (a composite-only difference would be merely unverifiable — content, selection and
// grading move indistinguishably inside one hash).
const manifest = (loginCaseDigest: string): ScorecardManifest => ({
  dataset: { id: "bench", version: "7.0.0", digest: `sha256:composite-${loginCaseDigest}` },
  cases: { login: loginCaseDigest },
  grading: "sha256:grading-a",
  harness: { id: "agent", version: "1.0.0" },
});

describeTrust("TRUST-21 — a confounded pair cannot gate green", () => {
  const baseline = card([result("login", true)]);
  const candidate = card([result("login", false)]); // a broke transition, if anyone had the right to count it

  it("a verified dataset-content difference refuses the gate — acknowledgment is the only way through, and it is recorded", () => {
    const experiment = experimentIdentity(manifest("sha256:content-a"), manifest("sha256:content-b"));
    expect(experiment.confounds.map((c) => c.axis)).toEqual(["dataset_content"]);
    const diff = { ...diffScorecards(baseline, candidate), experiment };

    const refused = evaluateGate(diff, { maxRegressions: 0 });
    expect(refused.decision).toBe("not_comparable");
    expect(refused.reasons[0]?.kind).toBe("confounded");

    const acknowledged = evaluateGate(diff, { maxRegressions: 0, allowConfounds: ["dataset_content"] });
    expect(acknowledged.decision).toBe("block"); // the broke case now counts — under a RECORDED acknowledgment
    expect(acknowledged.reasons.some((r) => r.kind === "confounded" && r.detail.includes("accepted"))).toBe(true);
  });

  it("identical seals hold every axis and the gate proceeds clean — the treatment axis (harness) never confounds", () => {
    const experiment = experimentIdentity(manifest("sha256:content-a"), manifest("sha256:content-a"));
    expect(experiment.confounds).toEqual([]);
    const g = evaluateGate(
      { ...diffScorecards(baseline, card([result("login", true)])), experiment },
      { maxRegressions: 0 },
    );
    expect(g.decision).toBe("pass");
  });
});

describeTrust("TRUST-22 — a refusal carries no verdict numbers", () => {
  it("a confound refusal presents structure only — never the regressions it had no right to derive", () => {
    const experiment = experimentIdentity(manifest("sha256:a"), manifest("sha256:b"));
    const diff = { ...diffScorecards(card([result("x", true)]), card([result("x", false)])), experiment };
    const g = evaluateGate(diff, { maxRegressions: 0 });
    expect(g.decision).toBe("not_comparable");
    expect(g.evidence.regressions).toBeUndefined();
    expect(g.evidence.improvements).toBeUndefined();
    expect(g.evidence.comparability).toBe("none");
  });

  it("an unresolvable stamp refuses the same way — and the diff itself computed NO transitions for it", () => {
    const diff = diffScorecards(card([result("x", true)]), card([result("x", false)]), {
      baselinePolicy: "unresolvable",
    });
    expect(diff.caseTransitions).toEqual([]); // unknown policy means unknown verdict — nothing minted upstream either
    expect(diff.transitionsUnavailable).toBe("baseline");
    const g = evaluateGate(
      { ...diff, policyUnresolvable: { baseline: { id: "composed", version: "0a1b2c3d", digest: "gone" } } },
      { maxRegressions: 0 },
    );
    expect(g.decision).toBe("not_comparable");
    expect(g.evidence.regressions).toBeUndefined();
  });
});

describeTrust("TRUST-25 — a grading-only change claims exactly ONE axis", () => {
  it("changing only the grading moves grading_plan and nothing else — the composite seal used to claim the dataset changed too", () => {
    const experiment = experimentIdentity(
      { ...manifest("sha256:case-a"), grading: "sha256:grading-A" },
      { ...manifest("sha256:case-a"), grading: "sha256:grading-B" },
    );
    expect(experiment.confounds.map((c) => c.axis)).toEqual(["grading_plan"]);
    expect(experiment.held).toContain("dataset_content");
  });
});

describeTrust("TRUST-26 — a subset is coverage loss, never a dataset confound", () => {
  it("a candidate that ran fewer cases stays a PARTIAL comparison the coverage knobs govern — not 'a different experiment'", () => {
    // Baseline sealed two cases; the candidate deliberately ran one. The shared case verifies identical, so
    // identity holds and the pair reaches the coverage machinery — where allow_partial has its own say.
    const baseline = {
      ...manifest("sha256:case-login"),
      cases: { login: "sha256:case-login", search: "sha256:case-search" },
    };
    const candidate = { ...manifest("sha256:case-login"), cases: { login: "sha256:case-login" } };
    const experiment = experimentIdentity(baseline, candidate);
    expect(experiment.confounds).toEqual([]);
    expect(experiment.held).toContain("dataset_content");

    const diff = {
      ...diffScorecards(card([result("login", true), result("search", true)]), card([result("login", true)])),
      experiment,
    };
    const g = evaluateGate(diff, { maxRegressions: 0 });
    expect(g.decision).toBe("blocked_missing"); // coverage speaks — require_full withholds, it does not refuse identity
    expect(g.reasons.some((r) => r.kind === "missing_cases")).toBe(true);
  });
});

describeTrust("TRUST-27 — unverifiable identity cannot gate green", () => {
  it("an unsealed side refuses the gate by default; the acknowledgment is explicit and recorded", () => {
    const experiment = experimentIdentity(undefined, manifest("sha256:case-a"));
    const diff = { ...diffScorecards(card([result("x", true)]), card([result("x", true)])), experiment };
    const refused = evaluateGate(diff, { maxRegressions: 0 });
    expect(refused.decision).toBe("not_comparable");
    expect(refused.reasons[0]?.kind).toBe("identity_unverified");
    expect(refused.evidence.regressions).toBeUndefined();
    const acknowledged = evaluateGate(diff, { maxRegressions: 0, allowUnverifiedIdentity: true });
    expect(acknowledged.decision).toBe("pass");
    expect(acknowledged.reasons.some((r) => r.kind === "identity_unverified" && r.detail.includes("accepted"))).toBe(
      true,
    );
  });
});

describeTrust(
  "TRUST-30 — the judge closure is identity: a nested latest resolving differently is recorded and confounds",
  () => {
    it("same judge document, different sealed concrete model ⇒ judge_set confound; unresolved seals stay unverifiable", () => {
      const withJudge = (model: string) => ({
        ...manifest("sha256:case-a"),
        judges: [{ id: "quality", version: "3", specDigest: "sha256:same-doc", model }],
      });
      const moved = experimentIdentity(withJudge("judge-default@5.0.0"), withJudge("judge-default@6.0.0"));
      expect(moved.confounds.map((c) => c.axis)).toEqual(["judge_set"]);
      const g = evaluateGate(
        { ...diffScorecards(card([result("x", true)]), card([result("x", true)])), experiment: moved },
        { maxRegressions: 0 },
      );
      expect(g.decision).toBe("not_comparable");
      const unresolved = experimentIdentity(withJudge("unresolved"), withJudge("unresolved"));
      expect(unresolved.unverified.map((u) => u.axis)).toEqual(["judge_set"]);
    });
  },
);
