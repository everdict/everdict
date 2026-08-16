import { z } from "zod";

// ── THE UNIT OF EVAL IDENTITY: (case, trial) ────────────────────────────────────────────────────────
//
// A batch with `trials > 1` fans one dataset case into N PHYSICAL executions, and every one of them is a
// separate observation: its own child run, its own commit receipt (the ledger's UNIQUE is `(scorecard, case,
// trial)`), its own trace, its own screenshot, its own verdict. `caseId` alone therefore names a GROUP, not
// a result — and every surface that addressed a result by `caseId` alone was silently addressing the group's
// last writer instead.
//
// `CaseKey` is that unit as one type. The rule it exists to keep: identity may be STRENGTHENED crossing a
// boundary, never narrowed — a caller holding a trial must not be able to hand a boundary something that
// cannot express it. `CaseResult`, `CaseJob` and `CaseCommitReceipt` all already carry both halves; this is
// the spelling everything that KEYS on them shares, from the job-runner cone (which produces the pair) up
// through the batch drivers, the artifact store and the receipt ledger.
export const CaseKeySchema = z.object({
  caseId: z.string().min(1),
  // ABSENT ≠ 0. Absent means "this execution has no trial axis" — a single-run case, which is the shape
  // every pre-trials record and every `trials <= 1` batch has on disk. Present-and-0 means "trial 0 of a
  // trialled case". The two collapse for KEYING (see `encodeCaseKey`) and stay distinct for ADDRESSING (see
  // `caseKeyAddress`), which is what keeps already-stored objects readable.
  trial: z.number().int().nonnegative().optional(),
});
export type CaseKey = z.infer<typeof CaseKeySchema>;

// Build the key from the two halves as they arrive off a `CaseResult`/`CaseJob` (where `trial` is optional).
// `undefined` is preserved rather than defaulted, because "no trial axis" is a fact about the execution.
export function caseKeyOf(caseId: string, trial?: number): CaseKey {
  return trial === undefined ? { caseId } : { caseId, trial };
}

// The delimiter between the two halves. `#` because that is what the ledger, the score plane and every
// existing map key already use (`@everdict/domain`'s `childKey`) — this function IS that spelling, promoted
// to the dependency root so the drivers, the artifact keys and the digest planes cannot drift into two.
const CASE_KEY_SEPARATOR = "#";

// Minimal INJECTIVE escape — the delimiter and the escape character, nothing else.
//
// A `caseId` is a free-form string (`EvalCase.id` is `z.string()`), so a dataset may legitimately carry
// `swe-bench/astropy__astropy-12907`, `flight:seat-map`, or an id with a literal `#` in it. Without an
// escape, `("a#1", trial 0)` and `("a", trial 1)` both spell `a#1` — two different executions colliding on
// one key, in the very maps the receipt ledger uses to say which receipt vouches for which case.
//
// Deliberately NOT `encodeURIComponent`: that also escapes `/`, `:`, `@`, `+` and spaces, all of which occur
// in real dataset case ids and NONE of which can create a collision here. Escaping them would move
// `scorePlaneDigest`/`observationSetDigest` for those datasets — digests that are pinned in the scoring
// ledger and in release gates, so a spelling change reads downstream as a plane that diverged. This escape
// is byte-identical to the old spelling for every id that does not contain `#` or `%`, and injective for the
// ones that do.
function escapeCaseId(caseId: string): string {
  return caseId.replaceAll("%", "%25").replaceAll(CASE_KEY_SEPARATOR, "%23");
}

function unescapeCaseId(escaped: string): string {
  return escaped.replaceAll("%23", CASE_KEY_SEPARATOR).replaceAll("%25", "%");
}

// The canonical KEY — what maps, sets and digest planes index a (case, trial) pair by.
//
// Absent trial collapses to 0 here on purpose: a single-run case and trial 0 of the same case are never both
// present in one plane (a batch is either trialled or it is not), and collapsing keeps single-run keying
// byte-identical to what every stored digest was computed under.
export function encodeCaseKey(key: CaseKey): string {
  return `${escapeCaseId(key.caseId)}${CASE_KEY_SEPARATOR}${key.trial ?? 0}`;
}

// The inverse — total over anything `encodeCaseKey` produced. A string with no separator has no trial axis
// to recover, so it decodes as the bare case (which is exactly what `caseKeyAddress` writes for one).
export function decodeCaseKey(encoded: string): CaseKey {
  const cut = encoded.lastIndexOf(CASE_KEY_SEPARATOR);
  if (cut < 0) return { caseId: unescapeCaseId(encoded) };
  const trial = Number(encoded.slice(cut + 1));
  if (!Number.isInteger(trial) || trial < 0) return { caseId: unescapeCaseId(encoded) };
  return { caseId: unescapeCaseId(encoded.slice(0, cut)), trial };
}

// The canonical ADDRESS — what a durable coordinate (an object-store key, a materialized trajectory's runId)
// spells this pair as.
//
// This is the one place the absent/0 distinction is load-bearing. A case with no trial axis keeps the BARE
// caseId it has always been stored under, so every artifact and trajectory already written stays readable at
// the address the record points at; a trialled case carries its trial, because k results sharing one address
// means k−1 of them are simply overwritten. Storage has no compare-and-swap to notice that happening.
export function caseKeyAddress(key: CaseKey): string {
  return key.trial === undefined ? key.caseId : encodeCaseKey(key);
}
