import {
  type CaseAttribution,
  type CaseDiagnosis,
  CaseDiagnosisSchema,
  isJudgeFamilyMetric,
} from "@everdict/contracts";

// ── A DIAGNOSIS IS READ OFF A JUDGE'S SCORE (docs/architecture/benchmark-evidence-spec.md §2) ────────
//
// A judge whose rubric asks for one writes a `CaseDiagnosis` object as its score `detail` (or under a `diagnosis`
// key beside a rationale). Only judge-family metrics are read: the family is the authority, and `sanitizeScore`
// keeps producers out of it. Anything that does not parse is ignored — a rationale sentence is not a diagnosis.
export type JudgedDiagnosis = CaseDiagnosis & { judge: string };
export function diagnosesOf(scores: ReadonlyArray<{ metric: string; detail?: unknown }>): JudgedDiagnosis[] {
  const out: JudgedDiagnosis[] = [];
  for (const score of scores) {
    if (!isJudgeFamilyMetric(score.metric)) continue;
    const candidate =
      typeof score.detail === "object" && score.detail !== null && "diagnosis" in score.detail
        ? (score.detail as { diagnosis: unknown }).diagnosis
        : score.detail;
    const parsed = CaseDiagnosisSchema.safeParse(candidate);
    if (parsed.success) out.push({ ...parsed.data, judge: score.metric });
  }
  return out;
}

// ── WHICH SLOT THE EVIDENCE POINTS AT (docs/architecture/evolution-routing-spec.md §2) ───────────────
//
// Pure over the diagnoses and the harness's SHAPE — its slots, each with the service name it runs and the tools it
// declares it owns. A single-slot harness attributes to that slot by construction. A topology attributes when the
// diagnoses' loci agree on one slot (a service named, or a tool one slot owns); disagreement and silence are both
// `unattributed`, with the reason in the platform's words — never a guess dressed as a measurement.
export interface HarnessSlot {
  slot: string;
  service?: string;
  tools: ReadonlyArray<string>;
}
export function attributeCase(
  diagnoses: ReadonlyArray<CaseDiagnosis>,
  slots: ReadonlyArray<HarnessSlot>,
): CaseAttribution {
  const only = slots.length === 1 ? slots[0] : undefined;
  if (only !== undefined) return { kind: "measured", slot: only.slot, because: ["the harness has one slot"] };
  if (slots.length === 0) return { kind: "unattributed", because: ["the harness declares no slots"] };
  const hits = new Map<string, string[]>();
  const hit = (slot: string, why: string) => hits.set(slot, [...(hits.get(slot) ?? []), why]);
  for (const d of diagnoses) {
    const service = d.locus?.service;
    if (service !== undefined) {
      const owner = slots.find((s) => s.service === service || s.slot === service);
      if (owner !== undefined) hit(owner.slot, `a ${d.kind} diagnosis names service ${service}`);
    }
    const tool = d.locus?.tool;
    if (tool !== undefined)
      for (const o of slots.filter((s) => s.tools.includes(tool)))
        hit(o.slot, `a ${d.kind} diagnosis names tool ${tool}, which slot ${o.slot} owns`);
  }
  const entries = [...hits.entries()];
  const single = entries.length === 1 ? entries[0] : undefined;
  if (single !== undefined) return { kind: "measured", slot: single[0], because: single[1] };
  if (entries.length > 1)
    return {
      kind: "unattributed",
      because: [`the diagnoses point at ${entries.length} slots: ${[...hits.keys()].sort().join(", ")}`],
    };
  return {
    kind: "unattributed",
    because: [
      diagnoses.length === 0 ? "no judge diagnosed this case" : "no diagnosis names a service or a tool a slot owns",
    ],
  };
}
