import { z } from "zod";

// ── THE AXES A BASELINE↔CANDIDATE COMPARISON HOLDS CONSTANT ──────────────────────────────────────────
//
// One owner, because this vocabulary was hand-spelled in EIGHT places — the domain type, the identity
// assembly's own array, the gate policy's `allowConfounds`, three wire enums, the API request DTO and the
// MCP tool schema. Eight copies of one predicate is the shape rule `protocol` L3 names, and adding an axis
// is what made the cost concrete: every copy had to learn the new value or silently reject a caller that
// used it.
//
// It lives in contracts because the gate policy (a wire contract) and the domain reading both need it, and
// contracts is the only place both may import from.
export const EXPERIMENT_AXES = [
  // What was evaluated.
  "dataset_content",
  // How it was graded.
  "grading_plan",
  // Which judges decided it.
  "judge_set",
  // Which model the harness actually ran, under a harness document that did not move.
  "harness_model",
  // WHICH BYTES IT RAN ON. A candidate that ran a different image than its baseline is a different
  // experiment, not a treatment comparison; attributing that delta to the change under test is the false
  // green light the gate exists to prevent (arch-review 58 follow-through).
  "execution_world",
  // WHICH WORLD IT ACTED ON, under a case document that did not move. A case names its environment by
  // reference (`EnvRefSchema`), so two batches over one dataset can run against two versions of the seed
  // repository, the fixture or the deployed app — and the delta is about the environment, never about the
  // harness under test (docs/architecture/harness-definability-spec.md §2). Embedded environments live
  // inside the case digest and are `dataset_content`'s axis; this one exists because a REFERENCE lets the
  // case stay identical while the world underneath it changes.
  "environment",
] as const;

export const ExperimentAxisSchema = z.enum(EXPERIMENT_AXES);
export type ExperimentAxis = z.infer<typeof ExperimentAxisSchema>;
