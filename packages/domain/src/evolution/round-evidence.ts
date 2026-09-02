import type { RoundEvidence, RoundEvidenceCase } from "@everdict/contracts";

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
}
export interface RoundEvidenceSide {
  scorecardId: string;
  version: string;
  // The side's per-case results, when the record carries them — the trace coordinates a reader follows.
  results?: ReadonlyArray<{ caseId?: string; runId?: string; trial?: number }>;
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
  const cases: RoundEvidenceCase[] = (input.trials?.cases ?? []).map((c) => ({
    caseId: c.caseId,
    heldOut: heldOut.has(c.caseId),
    target: targets.has(c.caseId),
    baseline: { rate: c.baselineRate, trials: c.baselineTrials },
    candidate: { rate: c.candidateRate, trials: c.candidateTrials },
    delta: c.delta,
    significant: c.significant,
    ...(c.p !== undefined ? { p: c.p } : {}),
    ...(c.method !== undefined ? { method: c.method } : {}),
    verdict: caseVerdict(c),
    traces: [
      ...tracesOf("baseline", input.baseline.results, c.caseId),
      ...tracesOf("candidate", input.candidate.results, c.caseId),
    ],
  }));
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
