import type { Predicate } from "@everdict/contracts";

// Predicate render/priority order — the everdict analog of digo-data's `LINK_PREDICATE_PRIORITY` (mentionGrounding.ts).
// When a node's related facts are capped for display, the highest-signal relationships survive: what a scorecard
// evaluated and measured beats the workspace-scoping edge. Pure policy, hence domain. Any predicate absent here sorts
// last (still shown, just after the ranked ones).
export const PREDICATE_PRIORITY: readonly Predicate[] = [
  // the intent story first — WHY something exists: what closed an issue, what verifies it, what was born from it
  "resolved_by",
  "verified_by",
  "born_from",
  // the eval story — what was tested, with what, judged how, scoring what
  "evaluates",
  "uses_dataset",
  "applies_judge",
  "measures",
  "compared_to",
  "supersedes",
  "derived_from",
  // provenance of a run/batch
  "fired_by",
  "runs_on",
  "placed_on",
  "child_of",
  // configuration wiring
  "uses_model",
  "uses_rubric",
  "adopts",
  "uses_secret",
  "uses_browser_profile",
  "pins_image",
  "runs_image",
  // integration & observability
  "triggers",
  "connects_repo",
  "exports_to",
  "pulls_from",
  // knowledge & comms — what a claim/skill is ABOUT is its headline fact, in both directions
  "about",
  "evidenced_by",
  "references",
  "discusses",
  "reply_to",
  "mentions",
  // classification & structure
  "tagged_with",
  "includes_case",
  "covers_case",
  // plan structure — where work sits (below the content facts, above raw scoping)
  "part_of",
  "assigned_to",
  // lineage / low-signal scoping
  "succeeds",
  "forked_from",
  "created_by",
  "member_of",
  "in_workspace",
];

const RANK = new Map<Predicate, number>(PREDICATE_PRIORITY.map((p, i) => [p, i]));

// Rank of a predicate for display ordering (lower = higher priority). Unknown predicates sort after all ranked ones.
export function predicateRank(p: Predicate): number {
  return RANK.get(p) ?? PREDICATE_PRIORITY.length;
}
