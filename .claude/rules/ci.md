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
  `pnpm web-imports`, `node scripts/live/empty-env-boot.mjs`, the self-contained web job
  (contracts build + `pnpm -F @everdict/web lint`/`build`), and a full-history gitleaks scan.
- `pnpm lint` is check-only and safe to run repo-wide; **fixes** stay scoped to files you
  changed — never run repo-wide formatters in this shared WIP tree.
- A failure you did not cause (someone else's WIP / earlier commit) still blocks your push:
  surface it to the maintainer instead of silently absorbing or bypassing it.
- After pushing, confirm the run went green:
  `gh run watch $(gh run list -L1 --json databaseId -q '.[0].databaseId') --exit-status`.
