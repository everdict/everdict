import {
  type CampaignFrame,
  type CampaignFrameFromIssue,
  CampaignFrameSchema,
  type IssueLinkType,
} from "@everdict/contracts";

// ── THE EXAM IS THE ISSUE'S (docs/architecture/evolution-routing-spec.md §3) ─────────────────────────
//
// An issue's `case` links say which cases it is about. A campaign opened from it takes those as `targets`,
// the linked dataset version's every other case as held-out, and states nothing else about the exam — so
// "the actual issue was resolved" is a question the frame can be held to. Two pure steps, because the service
// has to READ the dataset between them: first, which dataset version the links name; then, the frame.

export type CaseLinksAnswer =
  | { kind: "one"; dataset: string; version: string; caseIds: string[] }
  | { kind: "none" } // the issue links no cases — nothing to derive an exam from
  | { kind: "several"; datasets: string[] } // cases from more than one dataset: two exams, so two campaigns
  | { kind: "unpinned"; dataset: string } // a case link with no dataset version — the exam is not frozen
  | { kind: "mixed_versions"; dataset: string; versions: string[] };

export function caseLinksOf(
  links: ReadonlyArray<{ type: IssueLinkType | string; id: string; dataset?: string; version?: string }>,
): CaseLinksAnswer {
  const cases = links.filter((l) => l.type === "case");
  if (cases.length === 0) return { kind: "none" };
  const datasets = [...new Set(cases.map((l) => l.dataset).filter((d): d is string => d !== undefined))];
  if (datasets.length !== 1) return { kind: "several", datasets };
  const dataset = datasets[0] as string;
  if (cases.some((l) => l.version === undefined)) return { kind: "unpinned", dataset };
  const versions = [...new Set(cases.map((l) => l.version as string))];
  if (versions.length !== 1) return { kind: "mixed_versions", dataset, versions };
  return { kind: "one", dataset, version: versions[0] as string, caseIds: [...new Set(cases.map((l) => l.id))] };
}

export type FrameFromCasesAnswer = { kind: "frame"; frame: CampaignFrame } | { kind: "refused"; reason: string };

// `datasetCaseIds` is the dataset VERSION's case list, read by the service; `targets` the issue's case ids. The
// result goes through the creation schema, so a derived frame is refused for exactly what a hand-written one is
// (too few held-out cases, an undeclared family, …) — one rule, one owner.
export function frameFromCases(
  base: CampaignFrameFromIssue,
  datasetCaseIds: readonly string[],
  targets: readonly string[],
): FrameFromCasesAnswer {
  const known = new Set(datasetCaseIds);
  const foreign = targets.filter((id) => !known.has(id));
  if (foreign.length > 0)
    return {
      kind: "refused",
      reason: `the issue links cases the dataset version does not hold: ${foreign.join(", ")} — pin the links to the version that has them`,
    };
  const targetSet = new Set(targets);
  const { fromIssue: _fromIssue, ...rest } = base;
  void _fromIssue;
  const candidate = {
    ...rest,
    scenarios: datasetCaseIds.map((id) => ({ id, heldOut: !targetSet.has(id) })),
    targets: [...targets],
  };
  const parsed = CampaignFrameSchema.safeParse(candidate);
  if (!parsed.success) return { kind: "refused", reason: parsed.error.issues.map((issue) => issue.message).join("; ") };
  return { kind: "frame", frame: parsed.data };
}
