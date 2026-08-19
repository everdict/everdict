---
paths: "**/*"
---
# CI parity rules (push) — never push red

See skill `ci`.

- **NEVER `git push` before the full GitHub Actions CI passes locally.** Run `pnpm ci:local`
  (`scripts/ci-local.mjs`) — it mirrors `.github/workflows/ci.yml` step-for-step and, on a clean
  green tree, stamps `.git/everdict-ci-ok` with the HEAD sha.
- **Enforced, not advisory**: a PreToolUse hook (`scripts/hooks/pre-push-gate.mjs`, wired in
  `.claude/settings.json`) denies `git push` unless every commit the push carries is stamped and HEAD's stamp
  is `full`. Committing after the gate invalidates that commit's stamp — re-run `pnpm ci:local` (turbo cache
  makes it fast). Never work around the hook (no stamp forging, no pushing from outside the tool).
- **EVERY COMMIT IN A PUSH, NOT ONLY ITS TIP.** `pnpm ci:local` validates HEAD, and GitHub also only runs its
  checks on the tip — so a batch of eight commits used to ship seven that had never been built, while the split
  history advertised a bisectability it did not have and nothing downstream contradicted it. `.git/everdict-ci-ok`
  is a LEDGER now (`<sha> full|fast`), and **`pnpm ci:commits`** walks what is ahead of the remote and runs
  lint+typecheck+test on each in a throwaway worktree. Fast, not full, on purpose: gitleaks-over-all-history,
  the web build and the mutation suite answer questions about the tree being PUBLISHED, while a broken build or
  a failing test is what a bisect actually lands on. The two levels are recorded separately because stamping
  them alike would put the same lie one level down. So: `pnpm ci:commits` then `pnpm ci:local`, then push.
- The 5 essential commands are NOT the whole gate. CI additionally runs: `pnpm cone`,
  `pnpm web-imports`, `pnpm artifact-frame`, **`pnpm convention-harness`**, **`pnpm docs-check`**,
  **`pnpm constructed-casts`**, **`pnpm language-policy`**, **`pnpm source-bytes`**,
  **`pnpm protocol-mutations`**,
  `node scripts/live/empty-env-boot.mjs`, the self-contained web job (contracts build +
  `pnpm -F @everdict/web lint`/`build`), and a full-history gitleaks scan.
- **`pnpm convention-harness` keeps the conventions reachable**: every `.claude/rules/*.md` declares a
  `paths:` glob and that glob still matches live code, every referenced rule exists, every skill keeps the
  `description` the model matches on. A rule pointed at moved code is not a weak rule but an ABSENT one, and
  it fails silently — two were found dead this way (`suite.md`, `workspace-integrations.md`), both holding
  invariants a later review then found broken. Moving or renaming a package re-points its rule in the SAME
  change.
- **`pnpm docs-check` keeps the cited ADDRESSES real** — in `docs/**` and, since arch-review 56, in
  `.claude/rules/**` + `.claude/skills/**` too, from the one predicate rather than a second copy. The push
  layer is injected into context by a glob, so a rule citing a moved file teaches the wrong address at the
  moment of editing and nobody is reading it deliberately enough to notice: widening the existing check found
  29 dead paths across 7 skills on its first run. `docs/architecture/rearchitecture/**` is exempt on purpose
  (historical review records), and a path that is absent BY DESIGN goes in `KNOWN_ABSENT` with its reason.
  It also checks the SYMBOLS `.claude/**` names, because the rot that actually happens here is a file that
  stayed while the interface inside it was deleted — a backtick is a claim that this repo declares the name.
  Live means non-test `packages/`+`apps/`: tests are excluded because a ratchet keeps naming what it forbids,
  and `scripts/` because this check's own prose named its example and that alone made it pass. A name that is
  gone may still be WRITTEN — without backticks, as the deletion bullet in rule `backends` does.
- **`pnpm language-policy` keeps the repo English** (CLAUDE.md's language policy), as a RATCHET: the 550
  files that already carry Korean are recorded in `scripts/language-policy-baseline.txt` and pass, a file NOT
  in that list may not introduce it, and a baselined file that has been cleaned must leave the list in the
  same change. A bulk translation would be the wrong repair — those comments carry the REASON a piece of code
  is what it is, and precision is exactly what a sweep trades away. The debt is repaid where someone is
  already reading the file.
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
  (job name **`trust fast (real Postgres)`**) runs the Postgres-only trust subset on every push and PR, through
  `scripts/trust/trust-suite.mjs` so that a scenario which SKIPPED still fails the check. Scope = every
  `*.trust.test.ts` needing only Postgres: `apps/api/src/trust` minus the Temporal durability files, **plus
  `packages/` and `apps/agent`** — those two were nightly-only until arch-review 56, which is how a signature
  change left a package's scenario red for a day where the required check could not see it. The local gate
  deliberately boots no database, so this is the one required check you cannot pre-run with `ci:local`;
  reproduce it against a THROWAWAY Postgres (the suite migrates whatever you give it — never point it at a dev
  stack) with `EVERDICT_TRUST_DATABASE_URL=… node scripts/trust/trust-suite.mjs apps/api/src/trust
  '!apps/api/src/trust/temporal-' packages apps/agent`.
- **A trust scenario that SKIPS is not a passing one, and locally that is the default.** Without
  `EVERDICT_TRUST_DATABASE_URL` these files skip, so `pnpm test` going green says nothing about them. After
  changing anything a trust scenario asserts on — a return type especially, since `expect(x).toBe(false)`
  still compiles when `x` becomes an object — run the suite against a real Postgres before pushing.
  A change to a trust-suite subject (the commit ledger, the fences, the settle path) runs it BEFORE pushing.
  The full suite — Temporal, MinIO, Windows — stays nightly (`trust-nightly.yml`, non-blocking); see
  `docs/trust-certification.md`.
- A failure you did not cause (someone else's WIP / earlier commit) still blocks your push:
  surface it to the maintainer instead of silently absorbing or bypassing it.
- After pushing, confirm the run went green:
  `gh run watch $(gh run list -L1 --json databaseId -q '.[0].databaseId') --exit-status`.
