// The one-line declarations an `intent.md` may carry, read by every script that asks about them.
//
// `scripts/check-intent-chain.mjs` refuses an accepted intent with no spec and no declaration;
// `scripts/design/run.mjs` skips a declined intent on its rotation. Two readers of one line, so the line is
// defined once — a predicate written twice has already diverged (rule `protocol` L3), and the drift here would
// be the quiet kind: the chain accepts a spelling the rotation does not skip, and a declined intent gets a
// spec written over its decision.
//
// The form is the one `lessons/` adopted for `Eval case: none — <why>` and `scripts/fix-proof.mjs` uses for
// `Regression-test: none — <why>`: a declaration a check reads, never a heuristic over prose. A reason is
// required; `Design: none —` with nothing after the dash is not a declaration.

/** `Design: none — <why>` — the intent's author declined the design pass, in writing. */
export const DESIGN_DECLINED = /^Design:\s*none\s*[—-]\s*(\S.*)$/m;

/** @param {string} intentBody @returns {string | undefined} the reason, when the pass was declined */
export function designDeclined(intentBody) {
  return DESIGN_DECLINED.exec(intentBody)?.[1]?.trim();
}
