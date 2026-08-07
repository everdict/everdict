import type {
  GateAudit,
  GateDecision,
  GatePolicy,
  GateReason,
  ScorecardRecord,
  VerdictPolicyRef,
} from "@everdict/contracts";
import { contentDigest } from "../provenance/content-digest.js";
import type { ScorecardDiff } from "./scorecard.js";
import type { TrialDiff } from "./trials.js";

// Release-gate evaluation (metrics commercialization A1) — ONE pure derivation from the diff the trust
// kernel already computes. The gate's competitive claim is the middle decision: `not_comparable` is
// first-class, so an incomparable pair can never produce a false green light, and "no differences" is a
// different answer from "the comparison does not hold".
export type GateInput = ScorecardDiff & {
  trials?: TrialDiff;
  policyMismatch?: { baseline: VerdictPolicyRef; candidate: VerdictPolicyRef };
};

export type GateEvaluation = Pick<GateDecision, "decision" | "reasons" | "evidence">;

export function evaluateGate(diff: GateInput, policy: GatePolicy): GateEvaluation {
  const reasons: GateReason[] = [];
  // When trials rode along, the Fisher-gated trial diff is the authoritative regression signal — raw
  // last-trial pass transitions are noise on a trial run (the diffTrials contract).
  const trialsGated = diff.trials !== undefined;
  const regressions = trialsGated && diff.trials ? diff.trials.regressions.length : diff.regressions.length;
  const evidence: GateEvaluation["evidence"] = {
    comparability: diff.comparability,
    regressions,
    improvements: trialsGated && diff.trials ? diff.trials.improvements.length : diff.improvements.length,
    missingCases: diff.missing.casesOnlyInBaseline.length + diff.missing.casesOnlyInCandidate.length,
    trialsGated,
  };

  if (diff.comparability === "none") {
    if (diff.policyMismatch !== undefined) {
      reasons.push({
        kind: "policy_mismatch",
        detail: `the two batches were judged under different verdict policies (${diff.policyMismatch.baseline.digest} vs ${diff.policyMismatch.candidate.digest}) — their verdicts were produced by different rules`,
      });
    } else {
      reasons.push({
        kind: "no_shared_cases",
        detail: "no shared cases or metrics — there is nothing this comparison can claim",
      });
    }
    return { decision: "not_comparable", reasons, evidence };
  }

  if (trialsGated && diff.trials) {
    for (const r of diff.trials.regressions) {
      reasons.push({
        kind: "trial_regression",
        caseId: r.caseId,
        detail: `pass rate dropped ${r.baselineRate.toFixed(2)} → ${r.candidateRate.toFixed(2)} (statistically gated)`,
      });
    }
  } else {
    for (const r of diff.regressions) {
      reasons.push({ kind: "regression", caseId: r.caseId, detail: "case flipped pass → fail" });
    }
  }
  // Kind-changed metrics ride as informational reasons — the comparison holds elsewhere, but these columns
  // must not be read as deltas.
  for (const m of diff.incomparable) {
    reasons.push({
      kind: "kind_changed",
      metric: m.metric,
      detail: "metric changed value kind — its delta is unreadable",
    });
  }

  const blocking = reasons.filter((r) => r.kind === "regression" || r.kind === "trial_regression").length;
  return { decision: blocking > policy.maxRegressions ? "block" : "pass", reasons, evidence };
}

export function gatePolicyDigest(policy: GatePolicy): string {
  return contentDigest(policy);
}

// B2 — the audit window over the ledger's recorded decisions: counts by decision, every override with its
// stated reason, and the override rate (ABSENT when no block landed in the window — absence, never 0).
export function gateAudit(
  records: Array<Pick<ScorecardRecord, "id" | "gates">>,
  window?: { from?: string; to?: string },
): GateAudit {
  const decisions = { total: 0, pass: 0, block: 0, notComparable: 0 };
  const entries: GateAudit["overrides"]["entries"] = [];
  for (const record of records) {
    for (const g of record.gates ?? []) {
      if (window?.from !== undefined && g.decidedAt < window.from) continue;
      if (window?.to !== undefined && g.decidedAt > window.to) continue;
      decisions.total++;
      if (g.decision === "pass") decisions.pass++;
      else if (g.decision === "block") decisions.block++;
      else decisions.notComparable++;
      if (g.override) {
        entries.push({
          candidate: g.candidate,
          gateId: g.id,
          baseline: g.baseline,
          by: g.override.by,
          reason: g.override.reason,
          at: g.override.at,
        });
      }
    }
  }
  return {
    ...(window?.from !== undefined ? { from: window.from } : {}),
    ...(window?.to !== undefined ? { to: window.to } : {}),
    decisions,
    overrides: { count: entries.length, entries },
    ...(decisions.block > 0 ? { overrideRate: entries.length / decisions.block } : {}),
  };
}
