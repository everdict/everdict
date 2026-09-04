# Plan: evals at the push gate

From: intent.md @ 9e2f0a4521f4bf7b04957784b3d0def038b79870

## Files that change

- `scripts/hooks/pre-push-gate.mjs` — guard the ledger read; add the eval arm.
- `evals/run.mjs` — stamp `.git/everdict-evals-ok` on a green full run over clean configuration.
- `.github/workflows/agent-evals.yml` — deleted.
- `.claude/rules/ci.md`, `evals/README.md`, `.claude/skills/ci/SKILL.md` — the delivery change and the
  named debt.
- `.gitignore` is untouched: `.git/` is not in the worktree.

## Order of work

1. **The fail-open first**, before anything leans on it. Wrap the ledger read; a ledger that cannot be read is
   a DENY with the reason, never a crash. Prove it with the payload that crashed it.
2. `evals/run.mjs` writes the stamp — only on a full green run (no `--only`, no `--drill`) and only when
   `CLAUDE.md` and `.claude/**` are clean against HEAD, because the suite tests HEAD plus a working-tree
   overlay of exactly those. Say why when it declines to stamp.
3. The gate's eval arm: if any commit this push carries touches `CLAUDE.md`, `.claude/**` or `evals/**`,
   `.git/everdict-evals-ok` must name HEAD.
4. Delete the workflow. Record the model-swap debt where someone will read it.
5. Drive the hook with synthetic payloads for every arm.

## Risks

- **A gate nobody can satisfy is a gate people route around.** The eval arm must fire only on configuration
  changes; an ordinary push must be untouched. Step 5 checks both directions, not just the deny.
- **The stamp could attest the wrong thing.** A green run over dirty configuration says nothing about HEAD.
  Hence the cleanliness condition, and hence declining to stamp rather than stamping quietly.
- **Deleting the workflow removes the only unattended model-swap check.** Real, and not repairable without CI
  credentials. It is recorded as a debt rather than dropped silently.

## Proof

- The payload that crashed the gate now returns a `deny` decision naming the missing ledger.
- With a configuration commit in the push and no eval stamp: DENY. With the stamp: ALLOW.
- With no configuration commit and no eval stamp: ALLOW — the arm does not fire.
- `pnpm agent-evals` green writes the stamp; a run with dirty `CLAUDE.md` declines and says so.
- `pnpm lint` + `pnpm intent-chain` green.
