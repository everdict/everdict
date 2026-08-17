import type { CaseResult } from "./eval-case.js";
// ── A READ THAT FAILED IS NOT AN EMPTY SET (arch-review 53, Wave A.5) ────────────────────────────────
//
// The system kept converting "I could not find out" into "there is nothing", by one idiom in several
// places — `.catch(() => [])`, `.catch(() => undefined)` — and then taking the action reserved for genuine
// absence:
//
//   · the attempt ledger could not be listed → no work handles → the teardown widened to the case-id kill,
//     which stops other runs' compute;
//   · the receipt ledger could not be listed → no canonical attempt → the decision-grade evidence read
//     silently became the clock-resolved one;
//   · the runtime registry could not be read → no backend asked → a fold over zero answers certified that
//     live work was absent.
//
// Every one of those is the same substitution, and each was documented as deliberate at the site that made
// it ("an unreadable ledger is the same situation as an empty one"), which is what makes this a protocol
// decision to reverse rather than three slips to patch.
//
// `ReadResult` is the reversal, applied to the reads a DECISION rests on. It is deliberately NOT applied to
// every store read in the codebase: a list endpoint that fails should throw and become a 500, and wrapping
// it here would be ceremony. The admission test is the one the review states — does some caller widen scope,
// re-dispatch, complete a teardown, or admit evidence on the strength of this answer?
export type ReadResult<T> =
  // The read happened and this is what it found. An EMPTY value here is a real absence — the whole point of
  // separating it from the case below.
  | { kind: "read"; value: T }
  // The read happened and the thing is not there. Distinct from `read` with an empty value only where the
  // caller cares about the difference between "no rows" and "no such subject"; most callers treat them alike.
  | { kind: "absent" }
  // The read did not happen. `reason` is an operator diagnostic and never control: a caller decides what to
  // do from the KIND, so no code path can start pattern-matching on error text.
  | { kind: "unknown"; reason: string };

export const readOk = <T>(value: T): ReadResult<T> => ({ kind: "read", value });
export const readUnknown = <T>(reason: string): ReadResult<T> => ({ kind: "unknown", reason });

// Run a read that may throw, and keep the failure as `unknown` instead of as an empty answer. The one place
// the `.catch(() => [])` idiom is allowed to live, because here it produces the honest value.
export async function readOrUnknown<T>(read: () => Promise<T>, what: string): Promise<ReadResult<T>> {
  try {
    return { kind: "read", value: await read() };
  } catch (err) {
    return { kind: "unknown", reason: `${what}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// Did this read establish what is there? `false` for `unknown` ONLY — an absent subject is established.
export function readEstablished<T>(result: ReadResult<T>): boolean {
  return result.kind !== "unknown";
}

// ── WHAT A RECOVERY DECIDED, ACROSS EVERY LANE IT ASKED (arch-review 54, Phase 2) ────────────────────
//
// The control-plane-side answer, folded from the per-backend `AdoptOutcome`s (@everdict/backends) of every runtime a record
// could have been placed on. It is a union for the same reason `AdoptOutcome` is one, restated at the layer
// that has to
// ACT: the seam above this used to return `{ result?: CaseResult; established: boolean }` and its caller read
// only `result`, so `unknown` — an adoption nobody could establish — became "nothing to adopt" and the record
// was re-dispatched while its original job was possibly still running.
//
// `unknown` is not an error and not an absence. It is a decision NOT to decide, and the only correct response
// is to leave the record for the next sweep.
export type AdoptionDecision =
  | { kind: "adopted"; result: CaseResult }
  | { kind: "absent" }
  | { kind: "unknown"; reason: string };
