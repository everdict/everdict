import type { RoundEvidence, RoundEvidenceCase } from "@everdict/contracts";
import { type HarnessSlot, type JudgedDiagnosis, attributeCase } from "./diagnosis.js";

// ── THE ROUND'S EVIDENCE, DERIVED (docs/architecture/benchmark-evidence-spec.md §3) ──────────────────
//
// Pure over what the service already holds when it logs a round. Structural inputs, so the service's own diff
// and side types satisfy it without this package learning their whole surface.
export interface RoundEvidenceInput {
  campaignId: string;
  seq: number;
  frameDigest: string;
  frame: { scenarios: ReadonlyArray<{ id: string; heldOut: boolean }>; targets: ReadonlyArray<string> };
  baseline: RoundEvidenceSide;
  candidate: RoundEvidenceSide;
  trials?: {
    cases: ReadonlyArray<{
      caseId: string;
      baselineRate: number;
      baselineTrials: number;
      candidateRate: number;
      candidateTrials: number;
      delta: number;
      significant: boolean;
      p?: number;
      method?: string;
    }>;
  };
  verdict: RoundEvidence["aggregate"];
  at: string;
  // The candidate harness's slots (routing spec §2) — the shape attribution is measured against. Absent = the
  // shape could not be read, and every non-improved case is `unattributed` with that reason.
  slots?: ReadonlyArray<HarnessSlot>;
  slotsUnreadable?: string;
}
export interface RoundEvidenceSide {
  scorecardId: string;
  version: string;
  // The side's per-case results, when the record carries them — the trace coordinates a reader follows, and the
  // diagnoses the SERVICE already parsed off the result's measured judge scores (evidence spec §2). Parsed there,
  // not here: a domain file may not read a raw score array (the measured-gate guard), and the service is the one
  // place that already filters `isMeasured` for every other reader.
  results?: ReadonlyArray<{
    caseId?: string;
    runId?: string;
    trial?: number;
    diagnoses?: ReadonlyArray<JudgedDiagnosis>;
  }>;
}

function caseVerdict(c: { delta: number; significant: boolean }): RoundEvidenceCase["verdict"] {
  if (c.significant) return c.delta > 0 ? "improved" : "regressed";
  return c.delta === 0 ? "unchanged" : "unclear";
}

function tracesOf(side: "baseline" | "candidate", results: RoundEvidenceSide["results"], caseId: string) {
  return (results ?? [])
    .filter((r) => r.caseId === caseId && r.runId !== undefined)
    .map((r) => ({ side, runId: r.runId as string, ...(r.trial !== undefined ? { trial: r.trial } : {}) }));
}

export function roundEvidenceOf(input: RoundEvidenceInput): RoundEvidence {
  const heldOut = new Set(input.frame.scenarios.filter((s) => s.heldOut).map((s) => s.id));
  const targets = new Set(input.frame.targets);
  const cases: RoundEvidenceCase[] = (input.trials?.cases ?? []).map((c) => {
    const verdict = caseVerdict(c);
    // The candidate side's judges on this case — every trial's diagnoses, as the service parsed them.
    const diagnoses = (input.candidate.results ?? [])
      .filter((r) => r.caseId === c.caseId)
      .flatMap((r) => r.diagnoses ?? []);
    const attribution =
      verdict === "improved"
        ? undefined
        : input.slots === undefined
          ? {
              kind: "unattributed" as const,
              because: [`the harness shape could not be read: ${input.slotsUnreadable ?? "no shape given"}`],
            }
          : attributeCase(diagnoses, input.slots);
    return {
      caseId: c.caseId,
      heldOut: heldOut.has(c.caseId),
      target: targets.has(c.caseId),
      baseline: { rate: c.baselineRate, trials: c.baselineTrials },
      candidate: { rate: c.candidateRate, trials: c.candidateTrials },
      delta: c.delta,
      significant: c.significant,
      ...(c.p !== undefined ? { p: c.p } : {}),
      ...(c.method !== undefined ? { method: c.method } : {}),
      verdict,
      traces: [
        ...tracesOf("baseline", input.baseline.results, c.caseId),
        ...tracesOf("candidate", input.candidate.results, c.caseId),
      ],
      diagnoses,
      ...(attribution !== undefined ? { attribution } : {}),
    };
  });
  return {
    campaignId: input.campaignId,
    seq: input.seq,
    frameDigest: input.frameDigest,
    baseline: { scorecardId: input.baseline.scorecardId, version: input.baseline.version },
    candidate: { scorecardId: input.candidate.scorecardId, version: input.candidate.version },
    cases,
    aggregate: input.verdict,
    at: input.at,
  };
}

// Content-addressed: the digest is IN the key, so two stagings of one round (a retry that lost the append race,
// a concurrent driver) cannot overwrite each other's bytes under one name — the round's reference stays true.
export function roundEvidenceKey(campaignId: string, seq: number, digest: string): string {
  const hex = digest.replace(/^sha256:/, "").slice(0, 12);
  return `campaigns/${campaignId}/rounds/${seq}/${hex}.json`;
}
