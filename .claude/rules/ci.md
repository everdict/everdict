---
paths: "**/*"
---
# CI parity rules (push) — never push red

See skill `ci`.

- **NEVER `git push` before the full GitHub Actions CI passes locally.** Run `pnpm ci:local`
  (`scripts/ci-local.mjs`) — it mirrors `.github/workflows/ci.yml` step-for-step and, on a clean
  green tree, stamps `.git/everdict-ci-ok` with the HEAD sha.
- **Enforced, not advisory**: a PreToolUse hook (`scripts/hooks/pre-push-gate.mjs`, wired in
  `.claude/settings.json`) denies `git push` unless the stamp matches HEAD. Committing after the
  gate invalidates the stamp — re-run `pnpm ci:local` (turbo cache makes it fast). Never work
  around the hook (no stamp forging, no pushing from outside the tool).
- The 5 essential commands are NOT the whole gate. CI additionally runs: `pnpm cone`,
  `pnpm web-imports`, `pnpm artifact-frame`, **`pnpm convention-harness`**, **`pnpm protocol-mutations`**,
  `node scripts/live/empty-env-boot.mjs`, the self-contained web job (contracts build +
  `pnpm -F @everdict/web lint`/`build`), and a full-history gitleaks scan.
- **`pnpm convention-harness` keeps the conventions reachable**: every `.claude/rules/*.md` declares a
  `paths:` glob and that glob still matches live code, every referenced rule exists, every skill keeps the
  `description` the model matches on. A rule pointed at moved code is not a weak rule but an ABSENT one, and
  it fails silently — two were found dead this way (`suite.md`, `workspace-integrations.md`), both holding
  invariants a later review then found broken. Moving or renaming a package re-points its rule in the SAME
  change.
- **`pnpm protocol-mutations` is the "does the suite actually catch this" check** (arch-review 53, Wave F):
  it neutralizes one protocol at a time in a production file and requires the suite that claims to enforce it
  to go RED, reverting in a `finally`. It refuses to start on a dirty worktree for the files it mutates. A
  green suite proves the tests pass; this proves they would fail without the protocol — a distinction this
  repo has paid for twice (a scanner draft green over the defect it was written for, a judgment fixture that
  certified a gap). A new protocol adds its mutation there; a mutation whose target line is gone FAILS rather
  than silently testing nothing.
- `pnpm lint` is check-only and safe to run repo-wide; **fixes** stay scoped to files you
  changed — never run repo-wide formatters in this shared WIP tree.
- **`trust-fast` is a REQUIRED check and `pnpm ci:local` does not cover it.** `.github/workflows/trust-fast.yml`
  (job name **`trust fast (real Postgres)`**) runs the Postgres-only trust subset — `apps/api/src/trust` minus
  the Temporal durability files — on every push and PR, through `scripts/trust/trust-suite.mjs` so that a
  scenario which SKIPPED still fails the check. The local gate deliberately boots no database, so this is the
  one required check you cannot pre-run with `ci:local`; reproduce it against any throwaway Postgres with
  `EVERDICT_TRUST_DATABASE_URL=… node scripts/trust/trust-suite.mjs apps/api/src/trust '!apps/api/src/trust/temporal-'`.
  A change to a trust-suite subject (the commit ledger, the fences, the settle path) runs it BEFORE pushing.
  The full suite — Temporal, MinIO, Windows — stays nightly (`trust-nightly.yml`, non-blocking); see
  `docs/trust-certification.md`.
- A failure you did not cause (someone else's WIP / earlier commit) still blocks your push:
  surface it to the maintainer instead of silently absorbing or bypassing it.
- After pushing, confirm the run went green:
  `gh run watch $(gh run list -L1 --json databaseId -q '.[0].databaseId') --exit-status`.
