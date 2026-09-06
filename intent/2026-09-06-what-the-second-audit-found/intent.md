# Intent: what the second audit found — a side door in the gate, a watcher that only rehearses, and three positions nobody wrote down

Author: maintainer (via AI-native SDLC audit, 2026-09-06). Status: accepted

## Problem

The first audit built this harness; the second one, run against it a day later, scored it G2 on the branch
and found that eight plays sit below their ceiling with no declaration, that the drills fail, and that the one
control everything else rests on has a hole. In order of what it costs:

- **The push gate does not see a push from a linked worktree.** `pre-push-gate.mjs` compares
  `git rev-parse --show-toplevel` to the repository root, and a linked worktree's toplevel is the worktree.
  `git -C <worktree> push`, or a plain `git push` with cwd inside one, exits the hook silently and writes no
  ledger line. Two synthetic payloads confirmed it; a linked worktree checked out at `main` was live at the
  time. This repository's own eval runner, reviewer and commit gate create linked worktrees, so the path is
  ordinary. Declared-limits §2 files "a push from another checkout" under managed settings; this is the same
  tool, the same settings, the same session.
- **The watcher only rehearses.** The local CI-parity gate calls `watch-bands --dry-run`, which prints "would file"
  and exits 0 on a 3σ breach. The detection runs without a person; the filing still needs one to read the
  output and type the command. That is L2 for a gate play whose whole point is L3.
- **An accepted intent triggers nothing.** `pnpm design --next` is a start button; `intent-chain` emits a
  note. The position "a spec is optional" lives in `intent/README.md` and a shipped intent's constraints,
  not on the declared-limits page — the exact shape that page exists to refuse.
- **A fix's regression test has no reader.** CLAUDE.md says every fix ships a test that fails on the pre-fix
  code; nothing checks either half. Drill 3 row 6 (a test file edited during a fix) has no mechanism at all,
  and declared-limits §4 says rows 3–6 were driven against the hook, which for row 6 is not true.
- **A removal drill went stale silently.** `biome-write-is-not-evidence` still passed with its lesson
  removed, because the lesson had been copied into `lessons/2026-09-06-a-pipe-exits-with-the-last-command.md`
  and `evals/README.md`, neither in the case's `subject`. The runner checks that a neutralization is PRESENT
  in some subject, never that it is ABSENT elsewhere; drills are run once at case creation, recorded nowhere,
  and never re-run.
- **Every GitHub Actions workflow has been disabled since 2026-08-21**, and rule `ci` still says "confirm
  the run went green". Nothing in the tree records that the local gate IS the pipeline.
- **Nothing collects the telemetry every session emits.** The sink is a command somebody runs in a second
  terminal; the ledger holds two probe lines from the day it was written.
- Smaller, same shape: scan findings carry a confidence and no validation result; the skills index names no
  enforcing partner for any policy; the eval suite calls an alias a pin; `close-what-can-be-closed` shipped
  and still says `accepted`; play 16 is N/A and nobody said so.

## Proposed outcome

The gate guards every checkout that shares its `.git`. A 3σ breach refuses the push until the intent it
proposes exists. An accepted intent either has a spec or says in one line why it does not, and the chain
refuses the third state. A fix commit in `packages/**` or `apps/**` either carries a test or says why not, and
the commit gate proves the test was red on the pre-fix code. A drill result is a ledger line, a lesson that
leaks outside a case's subjects is refused at load, and `--drill-all` exists. A session starts its own
collector. The three positions are on the declared-limits page with their falsifiers, §4 says what is true,
and the drill certificates are committed where the next audit reads them.

## Affected users and systems

`scripts/hooks/pre-push-gate.mjs`, `scripts/check-guardrails.mjs`, `scripts/bands/watch.mjs`,
`scripts/ci-local.mjs`, `scripts/ci-commits.mjs`, a new `scripts/check-fix-proof.mjs`,
`scripts/check-intent-chain.mjs`, `scripts/design/run.mjs`, `scripts/scan/run.mjs`, `evals/run.mjs`,
`scripts/telemetry/`, `.claude/settings.json`, `.claude/rules/ci.md`, `.claude/skills/README.md`,
`.claude/skills/ci/SKILL.md`, `CLAUDE.md`, `docs/architecture/harness-declared-limits.md`, a new
certificates page, `intent/` templates and README, `lessons/`.

## Constraints

- **No new bypass to make anything testable.** The gate's ledgers stay where they are; the worktree fix is
  verified by driving the hook against a real linked worktree in a probe mode that decides nothing and
  records nothing.
- **A green run must not get slower or costlier.** The bands stay dry-run in the gate; only the exit code
  changes at 3σ. The fix proof runs inside the commit gate's existing worktree and only for commits that
  touch both a test and a source file.
- **Declarations, not heuristics.** "No design pass" and "no regression test" are one-line declarations a
  check reads, in the form `lessons/` adopted yesterday — never inferred from prose.
- **History is not rewritten.** The fix-proof rule applies to commits after the check landed; the chain's
  citations stay valid.
- **Remote CI is declared off, not switched on.** Re-enabling seven workflows is a billing decision the
  maintainer makes; the tree records the state it is in.

## Open questions

- Should the 2σ tier also refuse in dry-run? Carried: a diagnosis is a read-only model call that records
  nothing, so refusing until it runs would buy a printed paragraph.
- Does the fix proof need to rebuild a sibling package's `dist` before running a cross-package test? Answered
  in the plan: yes when the reverted source and the test live in different packages, because tests import
  siblings through `dist`.
