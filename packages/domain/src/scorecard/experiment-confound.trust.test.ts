import type { CaseResult, Scorecard, ScorecardManifest } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { experimentIdentity } from "./experiment-identity.js";
import { evaluateGate } from "./gate.js";
import { diffScorecards } from "./scorecard.js";

// Trust suite (docs/trust-certification.md) — TRUST-21 / TRUST-22.
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
const manifest = (datasetDigest: string): ScorecardManifest => ({
  dataset: { id: "bench", version: "7.0.0", digest: datasetDigest },
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
