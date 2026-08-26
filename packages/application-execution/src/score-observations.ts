import type {
  CaseObservations,
  ComputeHandle,
  ComputeSpec,
  EnvSnapshot,
  EvalCase,
  Grader,
  Score,
  StoreReader,
  TraceEvent,
} from "@everdict/contracts";
import { safeGrade } from "./safe-grade.js";

// The observation-scoring use-case — one owner for "score a case against its collected observations
// (trace + snapshot)". The topology backend delegates here after front-door drive + observe (placement
// adapters stop scoring — re-architecture P2b); runCase composes the same rule in-loop with slot
// ordering. skipComputeBound mirrors the two-phase separation: needsCompute graders were already
// scored inside the job (before compute release) and must never double-score.
export interface ScoreObservationsInput {
  evalCase: EvalCase;
  trace: TraceEvent[];
  snapshot: EnvSnapshot;
  graders: Grader[];
  skipComputeBound?: boolean;
  provision?: (spec: ComputeSpec) => Promise<ComputeHandle>; // dedicated grading compute (script grader image mode)
  readStore?: StoreReader; // read a data store's post-run slice (store-state grading, P2) — from a store-capable runtime
  // The run's observation channel, when the caller still holds it. Absent = this scoring path has no live
  // environment (control-plane re-score) — stated as unobserved below, never as an empty series (Track C).
  observations?: CaseObservations;
}

export async function scoreObservations(input: ScoreObservationsInput): Promise<Score[]> {
  const scores: Score[] = [];
  for (const grader of input.graders) {
    if (input.skipComputeBound && grader.needsCompute === true) continue;
    scores.push(
      ...(await safeGrade(grader, {
        case: input.evalCase,
        // Deferred observation scoring runs on the control plane, AFTER the case's own execution window — so
        // its budget starts here. The case's declared seconds are what bound it either way; what must not
        // happen is a grader with no bound at all.
        deadlineAt: Date.now() + input.evalCase.timeoutSec * 1000,
        trace: input.trace,
        snapshot: input.snapshot,
        ...(input.provision ? { provision: input.provision } : {}),
        ...(input.readStore ? { readStore: input.readStore } : {}),
        observations: input.observations ?? { kind: "unobserved", reason: "no_environment" },
      })),
    );
  }
  return scores;
}
