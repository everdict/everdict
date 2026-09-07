// The push gate's DECISION, as a pure function over facts (`scripts/hooks/pre-push-gate.mjs` gathers them).
//
// Separated so `scripts/check-guardrails.mjs` can drive it over a truth table. The alternative — an env var
// pointing the ledgers somewhere a test can write — would have made the check easy and the GATE FORGEABLE,
// which is the wrong trade for a control whose whole job is to be unforgeable.
//
// ⚠️ EVERY LEDGER IS NULLABLE, AND NULL DOES NOT MEAN "EMPTY". It means the ledger could not be read, which is
// a DENY with its own reason. An early version did a bare `readFileSync`, so a checkout that had never been
// gated threw — and a PreToolUse hook that exits non-zero without writing a decision lets the push through.
// The gate was open on exactly the state meaning "nothing here has ever been gated". Keeping the two states
// distinct in the SIGNATURE is what stops that returning.

/** Paths whose change makes a push carry the configuration that steers the agent. */
export const CONFIG_PATHS = ["CLAUDE.md", ".claude", "evals"];

/**
 * The same set as a git pathspec, minus the eval history.
 *
 * `evals/history.jsonl` is the record a run PRODUCES, not configuration a run tests, and treating it as the
 * latter closes a loop with no exit: appending a line dirties `evals/`, a dirty `evals/` refuses the stamp,
 * and earning the stamp appends another line. It is excluded in both places that ask the question — here for
 * the push, and in `evals/run.mjs` for the stamp — from this one definition, so the two cannot drift.
 */
export const CONFIG_PATHSPEC = [...CONFIG_PATHS, ":(exclude)evals/history.jsonl"];

/**
 * Code a review should see. A docs-only or intent-only push carries no risk a review would find, and pays
 * nothing.
 *
 * ⚠️ `scripts` is here because the gates live in it. Without it a push touching only `scripts/` — the push
 * gate itself, the review runner, the scan runner, `ci-local` — tripped neither this arm nor the eval arm, so
 * the harness was the one thing its own review never had to look at. Found by the first review that ran on a
 * merge-base range, in a batch that was almost entirely `scripts/`.
 */
export const PRODUCT_PATHS = ["packages", "apps", "scripts"];

/** Tags that publish. Each needs an authorization committed at `releases/<tag>.md`. */
export const RELEASE_TAG = /^(?:cli|desktop|api|web|agent|job-runner)-v\d|^v\d/;

/**
 * Which refusal fired, as a stable identifier.
 *
 * The decision ledger records this rather than the prose, because "denied" with no arm is the same shape of
 * record the ledger exists to replace — countable only as a total, never as "which control is costing what".
 * Reasons are written for a person reading one denial; arms are written for a query over a thousand.
 */
export const ARMS = /** @type {const} */ ({
  ALLOW: "allow",
  CI_LEDGER_UNREADABLE: "ci-ledger-unreadable",
  EVAL_LEDGER_UNREADABLE: "eval-ledger-unreadable",
  EVAL_STAMP_MISMATCH: "eval-stamp-mismatch",
  REVIEW_LEDGER_UNREADABLE: "review-ledger-unreadable",
  REVIEW_MISSING: "review-missing",
  RELEASE_UNAUTHORIZED: "release-unauthorized",
  TIP_UNSTAMPED: "tip-unstamped",
  COMMITS_UNSTAMPED: "commits-unstamped",
});

const short = (sha) => sha.slice(0, 9);

/**
 * @param {object} facts
 * @param {string} facts.head                          HEAD sha, "" when it cannot be resolved
 * @param {string[]} facts.pushed                      every commit this push would carry
 * @param {Map<string,string>|null} facts.ciLedger     sha -> "full"|"fast"; null = unreadable
 * @param {string[]|null} facts.evalLedger             agent-eval stamp lines; null = unreadable
 * @param {string[]|null} facts.reviewLedger           review stamp lines; null = unreadable
 * @param {boolean} facts.configChanged                the push touches CONFIG_PATHS
 * @param {boolean} facts.productChanged               the push touches PRODUCT_PATHS
 * @param {{tag: string, authorized: boolean}[]} facts.releaseTags  release tags pointing at HEAD
 * @returns {{allow: true, arm: string} | {allow: false, arm: string, reason: string}}
 */
export function decideGate({
  head,
  pushed,
  ciLedger,
  evalLedger,
  reviewLedger,
  configChanged,
  productChanged,
  releaseTags = [],
}) {
  // ── the release, first, because it is the one act with no undo ─────────────────────────────────
  //
  // A tag push publishes binaries and images to the public. Before this arm nothing was required first: no
  // record of what shipped, no statement of what verified it, no moment where a person authorized rather than
  // typed. It is checked ahead of the others so that the reason a release is refused is the release, and not
  // whichever cheaper gate happened to be unsatisfied at the same time.
  const unauthorized = releaseTags.filter((t) => !t.authorized).map((t) => t.tag);
  if (unauthorized.length > 0) {
    return {
      allow: false,
      arm: ARMS.RELEASE_UNAUTHORIZED,
      reason: `push blocked: HEAD carries release tag(s) ${unauthorized.join(", ")} with no authorization committed at releases/<tag>.md. A release is the one act here with no undo; write what ships, what verified it, and who authorizes.`,
    };
  }

  if (ciLedger === null) {
    return {
      allow: false,
      arm: ARMS.CI_LEDGER_UNREADABLE,
      reason:
        "push blocked: no CI-parity ledger (.git/everdict-ci-ok) — nothing in this checkout has ever been gated. Run `pnpm ci:local`.",
    };
  }

  // ── the configuration that steers the agent is tested too ──────────────────────────────────────
  //
  // `pnpm agent-evals` is not in `ci:local` and not in CI: a GitHub runner has no login, and the secret that
  // would give it one is a cost of the delivery choice rather than of the suite. What keeps it from sliding
  // back to advisory is this arm. Tip-only, unlike the CI ledger — that one is per-commit because a bisect
  // lands on an intermediate commit, and nobody bisects a skill's wording.
  if (configChanged) {
    if (evalLedger === null) {
      return {
        allow: false,
        arm: ARMS.EVAL_LEDGER_UNREADABLE,
        reason: `push blocked: this push changes the configuration that steers the agent (${CONFIG_PATHS.join(", ")}) and there is no agent-eval stamp. Run \`pnpm agent-evals\`.`,
      };
    }
    if (!evalLedger.some((line) => line.split(" ")[0] === head)) {
      return {
        allow: false,
        arm: ARMS.EVAL_STAMP_MISMATCH,
        reason: `push blocked: this push changes ${CONFIG_PATHS.join(", ")}, and .git/everdict-evals-ok does not stamp HEAD ${short(head)}. The structural checks cannot ask whether the agent still does the work to the same standard — run \`pnpm agent-evals\`.`,
      };
    }
  }

  // ── product code gets the same review every time ───────────────────────────────────────────────
  //
  // Asked, not answered: the stamp is written on COMPLETION, never on cleanliness. Findings rank and inform;
  // a person decides. What was missing was any moment at which the question had to be put — CLAUDE.md's
  // "Review-first … No exceptions" was fired by someone remembering, and skill `code-review` records that it
  // failed twice. A docs-only or intent-only push never meets this arm.
  //
  // ⚠️ The two ledger states are kept apart in the CODE, not only in the doc comment above. The first draft
  // wrote `reviewLedger !== null && reviewLedger.some(…)` and biome asked for `reviewLedger?.some(…)`, which
  // is behaviourally identical here and collapses exactly the distinction this file exists to preserve —
  // "never reviewed anything" and "reviewed something else" are different operational states with different
  // first sentences, and a query over a thousand denials wants them apart. Two arms, no optional chain.
  if (productChanged) {
    if (reviewLedger === null) {
      return {
        allow: false,
        arm: ARMS.REVIEW_LEDGER_UNREADABLE,
        reason: `push blocked: this push carries product code (${PRODUCT_PATHS.join(", ")}) and no review has ever run in this checkout. Run \`pnpm review\` — it records findings and stamps on completion, not on cleanliness.`,
      };
    }
    if (!reviewLedger.some((line) => line.split(" ")[0] === head)) {
      return {
        allow: false,
        arm: ARMS.REVIEW_MISSING,
        reason: `push blocked: this push carries product code and the review stamp does not name HEAD ${short(head)} — a review ran, then the tree moved. Run \`pnpm review\` again.`,
      };
    }
  }

  // ── every commit in the push, not only its tip ─────────────────────────────────────────────────
  const unstamped = pushed.filter((sha) => !ciLedger.has(sha));
  const tipLevel = ciLedger.get(head);
  if (head !== "" && unstamped.length === 0 && tipLevel === "full") return { allow: true, arm: ARMS.ALLOW };

  if (tipLevel !== "full") {
    return {
      allow: false,
      arm: ARMS.TIP_UNSTAMPED,
      reason: `push blocked: HEAD ${short(head)} has no FULL gate stamp. Run \`pnpm ci:local\` (mirrors .github/workflows/ci.yml), then push.`,
    };
  }
  return {
    allow: false,
    arm: ARMS.COMMITS_UNSTAMPED,
    reason: `push blocked: ${unstamped.length} of the ${pushed.length} commit(s) this push carries were never gated — ${unstamped
      .slice(0, 3)
      .map(short)
      .join(
        ", ",
      )}${unstamped.length > 3 ? ", …" : ""}. GitHub only checks the tip too, so these would be holes nothing contradicts. Run \`pnpm ci:commits\`.`,
  };
}
