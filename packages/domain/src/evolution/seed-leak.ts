// ── A SEED BORN FROM THE EXAM IS A LEAK (docs/architecture/harness-identity-and-seeds-spec.md §4) ─────
//
// The evolve skill's rule — the candidate never receives the findings — made total. A seed's evidence names
// scorecards; a scorecard covered cases; a case in the frame's held-out set is the exam. A seed whose evidence
// touches the exam is the exam mounted into the candidate, and the round that ran it is not comparable.
export interface SeedEvidence {
  seed: string; // `skill:<id>@<version>` or `knowledge:<id>` — the seed as the round names it
  scorecardId: string;
  caseIds: ReadonlyArray<string>;
}

export function seedLeakOf(evidence: ReadonlyArray<SeedEvidence>, heldOutIds: ReadonlySet<string>): string[] {
  const leaking = new Set<string>();
  for (const e of evidence) if (e.caseIds.some((id) => heldOutIds.has(id))) leaking.add(e.seed);
  return [...leaking].sort();
}
