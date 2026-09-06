# Plan: close what the second audit found

From: intent.md @ 7bb282eefdd54db9c72856323d160df727740a9e

## Files that change

- `scripts/hooks/pre-push-gate.mjs` — scope by `git rev-parse --git-common-dir`, facts read from the pushing
  checkout, ledgers in the common dir, a `--probe` mode that decides and records nothing.
- `scripts/check-guardrails.mjs` — half three (the scope, driven against a real `--no-checkout` linked
  worktree whose HEAD is moved one commit back) and half four (the watcher over two fixture series); the
  SessionStart wiring; a settings file that wires `--probe` is refused.
- `scripts/bands/watch.mjs` — a dry run that would file a 3σ intent exits non-zero and names the command;
  "already open" is asked across every date; `--source-dir` redirects the eval history too; drill lines are
  skipped by the eval-pass-rate reader. `scripts/bands/fixtures/{breach,quiet}/` + README.
- `scripts/check-intent-chain.mjs`, `scripts/design/run.mjs`, `intent/TEMPLATE.md`, `intent/README.md` —
  an accepted intent has `spec.md` or `Design: none — <why>`; the third state is refused; the rotation skips
  a declined intent.
- `scripts/fix-proof.mjs` (new, the rule and the proof as functions), `scripts/check-fix-proof.mjs` (new,
  the rule over a truth table and over commits newer than itself), `scripts/ci-commits.mjs` (the proof, in
  the worktree it already has), `package.json`, `scripts/ci-local.mjs`, `.github/workflows/ci.yml`.
- `evals/run.mjs` — the exclusivity refusal at load; drill lines in `history.jsonl` with a subject digest;
  `--drill-all`, `--drill-status`; the stamp refuses over a case with no red drill; the resolved model IDs
  from the envelope. Eleven cases' `subject` lists widened to the files that actually carry their lesson.
  `evals/README.md`.
- `scripts/scan/run.mjs` — a finding carries `validation` and `how`; the log line counts `reproduced`.
- `scripts/telemetry/ensure-sink.mjs` (new), `scripts/telemetry/otlp-sink.mjs` (ledger in the common dir),
  `.claude/settings.json` (SessionStart), `scripts/telemetry/README.md`.
- `.claude/skills/README.md` — the must-hold policies and what enforces each; `scripts/check-controls-documented.mjs`
  reads that table and refuses a row naming a control that does not exist.
- `docs/architecture/harness-declared-limits.md` — C2 (a spec is a decision per intent), C3 (remote CI is
  off; the local gate is the pipeline), C4 (a dry run refuses, it does not file), the p16 N/A declaration,
  §2 and §4 corrected. `docs/architecture/harness-drill-certificates.md` (new, indexed). `.claude/rules/ci.md`,
  `.claude/skills/ci/SKILL.md`, `CLAUDE.md`, `docs/architecture/harness-observability.md`,
  `lessons/2026-09-06-the-lesson-moved-and-the-drill-stayed-green.md`.

## Order of work

1. The gate's scope, and the check that drives it — everything else is enforced by this hook. Counterexample
   first: guardrails RED with the toplevel predicate on the two worktree rows, green with the common dir.
2. The watcher's refusal, with the fixture that shows the old watcher exiting 0 at 3.74σ.
3. The intent chain's third state, seen RED on this very intent before its spec landed.
4. The eval runner: the exclusivity refusal (seen RED on eleven cases, not the one the audit knew about), the
   drill ledger, `--drill-all`, `--drill-status`, the stamp condition, the resolved models. Then re-drill the
   stale case and see it go red.
5. The fix proof: the rule's truth table, then the proof driven against two synthetic fix commits in a scratch
   worktree — one whose test is red on the pre-fix code, one whose test is not — before it is wired into the
   commit gate.
6. The scan's validation field; one scope re-scanned to see the field arrive.
7. The collector's SessionStart hook, and guardrails refusing its absence.
8. The skills index's enforcing-partner table and the check that reads it.
9. The declarations, the corrected §2/§4, the certificates page, the rule and skill and CLAUDE.md wording,
   the lesson. Every new control named in rule `ci` (`pnpm controls-documented` refuses otherwise).
10. `pnpm agent-evals --drill-all`, then the full suite for the stamp; `pnpm ci:commits`; `pnpm review`;
    `pnpm ci:local`. Close the intent with the shipping sha.

## Risks

- **The fix proof's revert must leave the worktree byte-identical for the next commit.** Its restore runs in
  its own `finally`, rebuilds any sibling package it rebuilt, and is exercised by the synthetic commits in
  step 5 before it touches a real push. The riskiest step, and the reason it is proved on a scratch worktree
  first.
- **Widening eleven cases' subjects changes what the drill removes.** A subject that carries the lesson in a
  form the case did not anticipate could make the drill red for the wrong reason; `--drill-all` in step 10
  runs every case and its transcript names what the session did without the lesson.
- **The band refusal can be lifted by retuning a real band away.** Named as such in C4: the escape is the
  one the filed intent already offers, and the retune is committed with its reason.
- **A detached collector has no lifecycle.** One per machine, bound to a port, refused when the port is
  busy, dies with the machine. Accepted and written down in the observability page rather than bounded.

## Proof

- `pnpm guardrails` green, and RED on the two worktree rows when the scope predicate is swapped back.
- `node scripts/bands/watch.mjs --dry-run --only gate-denial-rate --source-dir scripts/bands/fixtures/breach`
  exits 1 and names `pnpm watch-bands`; `quiet` exits 0; the HEAD~ watcher exits 0 over `breach`.
- `pnpm intent-chain` RED on an accepted intent with neither spec nor declaration; green after the spec.
- `pnpm agent-evals --list` RED on the eleven leaking cases before their subjects widen; green after.
  `--drill biome-write-is-not-evidence` red after re-pointing (it was green on 2026-09-06 before).
- `pnpm fix-proof` green over its truth table; the synthetic proof PASSES on the commit whose test was red
  on the pre-fix code and FAILS on the one whose test was not.
- `pnpm scan --scope execution` records `validation` on every finding.
- All gates green; `pnpm agent-evals` stamps only after `--drill-all` has every case on record.
