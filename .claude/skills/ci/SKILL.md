---
name: ci
description: Local CI parity — run everything .github/workflows/ci.yml runs BEFORE any git push (pnpm ci:local = 5 quality gates + cone/web-imports/empty-env-boot + self-contained web job + gitleaks; a PreToolUse hook blocks unstamped pushes), and verify the run went green after. Use before committing/pushing, when CI fails on GitHub, or when editing .github/workflows or the gate/hook scripts.
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
---
# CI (local parity before every push)

**The rule: never push red.** Every push to `main` triggers `.github/workflows/ci.yml`; a red
`main` blocks everyone. Before `git push`, reproduce the FULL pipeline locally — the workflow
file is the SSOT (re-read it when in doubt; this skill mirrors it but the yml wins).

## The gate — one command
```bash
pnpm ci:local   # scripts/ci-local.mjs — mirrors ci.yml step-for-step
```
On success with a **clean tree** it stamps `.git/everdict-ci-ok` with the HEAD sha. A dirty-tree
pass prints green but does NOT stamp (CI validates the pushed commit, not your working tree):
commit first, then re-run — turbo cache makes the re-run fast.

## Enforcement — the pre-push hook
`.claude/settings.json` wires a PreToolUse hook (`scripts/hooks/pre-push-gate.mjs`) that **denies
`git push`** (compound commands included) unless the stamp matches the current HEAD. Any commit
after the gate invalidates the stamp by construction. The hook only guards THIS repo — pushes of
other repos pass through. Never work around it (no stamp forging, no pushing outside the tool);
if it blocks you wrongly, fix the hook, don't dodge it.

## What the gate runs (mirror of ci.yml, 3 jobs)
1. **core**: `pnpm lint` → `typecheck` → `test` → `build` → `cone` (agent-cone guard) →
   `web-imports` (web runtime-decoupling guard) → `node scripts/live/empty-env-boot.mjs`.
2. **web (self-contained)**: `pnpm -F @everdict/web lint` + `build`. ⚠ `next build` runs its own
   tsc — the root typecheck does NOT catch web type errors, and the web's type anchors need
   `@everdict/contracts` built first (in ci.yml an explicit step; locally the root build covers it).
3. **secret scan**: `gitleaks git . --config .gitleaks.toml --log-opts="--all" --no-banner` —
   **all history**, so a "leak" in any past commit (docs included) fails every future run until
   allowlisted in `.gitleaks.toml` (narrow regex, `regexTarget = "line"`) or rewritten out.
   A real secret means rotate + scrub, never allowlist. The gate auto-installs the pinned
   gitleaks (same version as ci.yml) to `~/.cache/everdict/` if missing.

When iterating on ONE failed step, run that step directly, then finish with a full `pnpm ci:local`.

## Failure protocol
1. **Your change broke it** → fix, re-run, push only on stamp.
   Fixes stay scoped to files you changed — never run repo-wide formatters here (shared WIP tree).
2. **Pre-existing failure** (someone else's WIP or an earlier commit) → it still blocks your
   push. Surface it to the maintainer; do not sweep others' files into your commit and do not
   push on top of red "because it wasn't me".
3. **Gate drift** (step exists in ci.yml but not in `scripts/ci-local.mjs`) → the yml wins; fix
   the gate script and this skill in the same PR (skills travel with the code).

## After pushing — confirm green (the push is not done until this is)
```bash
gh run watch $(gh run list -L1 --json databaseId -q '.[0].databaseId') --exit-status
```
If it fails remotely despite local green, diff the environment (node 22, `pnpm install
--frozen-lockfile`, clean checkout — e.g. locally-built `dist/` can mask a missing CI build step);
`gh run view <id> --log-failed` or `gh api repos/{owner}/{repo}/actions/jobs/<job-id>/logs` for
the exact step output.

See rule `ci.md` for the pushed critical rules.
