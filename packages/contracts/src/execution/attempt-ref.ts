import { z } from "zod";
import { attemptIdOf } from "../records/case-commit-receipt.js";

// ── THE ATTEMPT'S NAME, TRAVELLING OUTWARD (arch-review 52, Wave 1) ──────────────────────────────────
//
// `CaseJob.attemptId` says which physical execution a job IS, on the way IN. This is the reply shape — what
// a dispatch tells its caller about the execution that actually happened, which is not always the one the
// caller parked with (a self-hosted requeue re-leases the job, and that re-lease is a second execution).
//
// Every consumer used to be handed a bare recording GENERATION and had to rebuild the name from it
// (`attemptIdOf(executionId, generation)`). That derivation is exact whenever a generation exists — the
// ledger mints the ordinal and the row's id is that string by construction — and it has nothing to work
// with in the one case that matters most: an UNISOLATED attempt, whose ledger row exists precisely because
// the recording claim was refused. So the lane with no fence reported no attempt at all, and the caller kept
// naming the execution the re-lease had abandoned: receipt, artifact key and terminal stamp all said A about
// work B did.
//
// The ref carries the NAME, and the weaker coordinates ride along beside it rather than standing in for it.
export const AttemptRefSchema = z.object({
  // The ledger row's id — `<executionId>#g<generation>` (attemptIdOf), the same string the receipt, the
  // sealed trajectory and the artifact key spell. Required: a ref that cannot name its attempt is not a ref,
  // and the way to say "unknown" is to have none (see attemptRefOf, which answers `undefined`).
  attemptId: z.string(),
  // The logical execution the attempt belongs to (`evd-run-<id>` / `evd-<batchId>-<caseId>[-t<n>]`) — stable
  // across every attempt of that execution, so a consumer can key its own maps by it without re-parsing the
  // name above.
  executionId: z.string(),
  // The RECORDING fence this attempt owns, when it owns one. Absent = the recording claim was refused
  // (`unisolated`): the execution is real and its evidence is not canonical, which is a different statement
  // from "no attempt" and must not be collapsed into it.
  recording: z.object({ generation: z.number().int().nonnegative() }).optional(),
  // The self-hosted lease that produced it, when the attempt came from one — the (jobId, leaseEpoch) token
  // every evidence report on that lane is fenced by. Absent on managed dispatch, which has no lease.
  runnerLease: z.object({ jobId: z.string(), leaseEpoch: z.number().int().nonnegative() }).optional(),
});
export type AttemptRef = z.infer<typeof AttemptRefSchema>;

// The ONE place the generation→name derivation is still allowed to happen: an emitter that holds a
// generation and no row id (the recording-only composition, where no attempt ledger is wired) names the
// attempt the way every other consumer already spells it, rather than each consumer re-deriving it further
// downstream where the executionId may no longer be in scope.
//
// `undefined` when neither half is known — an execution nobody opened an attempt for. Absent is a fact a
// reader can act on; a fabricated coordinate is one they cannot tell from a real one.
export function attemptRefOf(input: {
  executionId: string;
  attemptId?: string;
  generation?: number;
  runnerLease?: { jobId: string; leaseEpoch: number };
}): AttemptRef | undefined {
  const named =
    input.attemptId !== undefined
      ? input.attemptId
      : input.generation === undefined
        ? undefined
        : attemptIdOf(input.executionId, input.generation);
  if (named === undefined) return undefined;
  return {
    attemptId: named,
    executionId: input.executionId,
    ...(input.generation !== undefined ? { recording: { generation: input.generation } } : {}),
    ...(input.runnerLease !== undefined ? { runnerLease: input.runnerLease } : {}),
  };
}
