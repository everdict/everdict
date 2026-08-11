import type { CheckpointRef, HandoffCheckpoint, TaskEnvelope } from "@everdict/contracts";

// THE VERIFIER'S ENVELOPE — the spawn-site half of the ownership protocol's independence invariant.
//
// The contract has said for several generations that a role which must see evidence only "gets an explicit
// read list", and that `scope.reads` is the field it fills. Both kernel guards were already there and already
// enforced on every call: `authorizeToolInvocation` decides which tools, `authorizeResourceAccess` decides
// which OBJECTS, and sub-agents inherit both. What did not exist was anything that BUILT such an envelope, so
// the guarantee had every enforcement it needed and no producer — which is why TRUST-31 could be written down
// and not certified.
//
// This is that producer, and it is pure: a checkpoint states the evidence its claims stand on, and that list
// IS the verifier's world. Three properties, each of which is the thing a verifier could otherwise be talked
// out of:
//
//   ① NO WRITES. Not a short write list — an empty one. A verifier that can change what it is judging is not
//      an independent actor, and "it only writes its own decision" is how that starts: filing the decision is
//      the control plane's act on the verdict it returns, not a capability the judgment runs with.
//   ② READS ARE A LIST, never "all". The executor posture (`reads: "all"`) is right for an agent whose senses
//      are its own; it is exactly wrong for one whose conclusion must be attributable to the evidence it was
//      given.
//   ③ RESOURCES ARE THE EVIDENCE. Holding `get_scorecard` and being pointed at `scorecard:sc-7` must not let
//      it read `sc-8` — the second guard exists for this, and an evidence-scoped envelope is the only thing
//      that ever fills it.
//
// UNRESOLVED refs stay in the list on purpose. A ref the platform could not resolve is part of the claim
// nobody checked, and dropping it here would quietly narrow the verifier's world to the convenient half —
// the runtime then records it as `unreachable`, which is a fact about the evidence rather than a silence.

// Which read tools address which evidence type. Deliberately explicit: deriving it from a naming convention
// would make the verifier's world depend on how a tool happens to be spelled.
const READS_FOR: Record<CheckpointRef["type"], readonly string[]> = {
  run: ["get_run", "get_run_trajectory", "list_runs"],
  scorecard: ["get_scorecard", "get_scorecard_case", "list_scorecards"],
  trace: ["get_run_trajectory", "get_trace"],
  issue: ["get_issue", "list_issues"],
  file: ["get_file", "list_files"],
  // An outside commit has no first-party reader; the ref travels so the runtime can record that nothing
  // could address it, rather than the envelope pretending the evidence was smaller than it is.
  commit: [],
};

export interface VerifierEnvelopeInput {
  id: string;
  checkpoint: HandoffCheckpoint;
  budgets: TaskEnvelope["budgets"];
}

// EVERY ref the checkpoint stands on — the same two fields `danglingCheckpointRefs` walks, because "what this
// claim rests on" has to be one answer. A verifier scoped to the facts but not to the actions taken could not
// check the half of the claim that says what was DONE.
export function checkpointEvidence(checkpoint: HandoffCheckpoint): CheckpointRef[] {
  const seen = new Map<string, CheckpointRef>();
  for (const fact of checkpoint.confirmedFacts) for (const ref of fact.refs) seen.set(`${ref.type}:${ref.id}`, ref);
  for (const action of checkpoint.actionsTaken) for (const ref of action.refs) seen.set(`${ref.type}:${ref.id}`, ref);
  return [...seen.values()];
}

export function verifierEnvelope(input: VerifierEnvelopeInput): TaskEnvelope {
  const evidence = checkpointEvidence(input.checkpoint);
  const reads = [...new Set(evidence.flatMap((ref) => READS_FOR[ref.type] ?? []))].sort();
  return {
    id: input.id,
    goal: `Verify the claims of checkpoint ${input.checkpoint.id} against the evidence it cites: ${input.checkpoint.goal}`,
    role: "verifier",
    scope: {
      // …plus the intrinsic tools the kernel always allows (thinking, answering). Everything else is refused.
      reads,
      writes: [],
      forbidden: [],
      // The OBJECT whitelist — the evidence, and nothing else in the workspace.
      resources: evidence.map((ref) => ({ type: ref.type, id: ref.id })),
    },
    budgets: input.budgets,
    stop: { onBudgetExhausted: "halt_checkpoint" },
    escalation: { onScopeExceeded: "refuse_and_replan" },
    // A verifier changes nothing, so there is nothing to roll back — the flag would be a promise about an
    // act this role cannot perform.
    rollbackRequired: false,
  };
}
