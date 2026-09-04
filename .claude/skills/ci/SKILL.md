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
   `web-imports` (web runtime-decoupling guard) → `artifact-frame` (the agent's sandboxed-dashboard design
   system must stay in step across contracts/web/theme) → `node scripts/live/empty-env-boot.mjs`.
2. **web (self-contained)**: `pnpm -F @everdict/web lint` + `build`. ⚠ `next build` runs its own
   tsc — the root typecheck does NOT catch web type errors, and the web's type anchors need
   `@everdict/contracts` built first (in ci.yml an explicit step; locally the root build covers it).
3. **secret scan**: `gitleaks git . --config .gitleaks.toml --log-opts="--all" --no-banner` —
   **all history**, so a "leak" in any past commit (docs included) fails every future run until
   allowlisted in `.gitleaks.toml` (narrow regex, `regexTarget = "line"`) or rewritten out.
   A real secret means rotate + scrub, never allowlist. The gate auto-installs the pinned
   gitleaks (same version as ci.yml) to `~/.cache/everdict/` if missing.

When iterating on ONE failed step, run that step directly, then finish with a full `pnpm ci:local`.

## The required check the gate does NOT mirror — `trust-fast`
`.github/workflows/trust-fast.yml` (job **`trust fast (real Postgres)`**) is a **required check** and runs
outside `ci:local` on purpose: it needs a real Postgres service, and booting a database before every push is
the cost the local gate exists to avoid. It runs the Postgres-only trust subset (`apps/api/src/trust` minus
the Temporal durability files) through `scripts/trust/trust-suite.mjs`, whose rule is that a scenario which
SKIPPED is a FAILED certification — a required check that quietly skips would be worse than none.

Touching a trust-suite subject (the commit ledger, the fences, settle, the receipt/attempt stores)? Run it
before pushing, against any throwaway Postgres:
```bash
docker run -d --rm --name pg-trust -e POSTGRES_USER=everdict -e POSTGRES_PASSWORD=everdict \
  -e POSTGRES_DB=everdict_trust -p 55440:5432 postgres:16
EVERDICT_TRUST_DATABASE_URL=postgresql://everdict:everdict@127.0.0.1:55440/everdict_trust \
  node scripts/trust/trust-suite.mjs apps/api/src/trust '!apps/api/src/trust/temporal-'
```
~5 min after `pnpm build`. The FULL suite (Temporal + MinIO + Windows) stays nightly and non-blocking —
`trust-nightly.yml`, `docs/trust-certification.md`.

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

## The gate the yml runs that this page used to omit
`ci.yml` grew well past the four bullets above; the yml is the SSOT and this skill names only what changes how
you work. One of them does: **`pnpm intent-chain`** enforces the Plan→Build handoff from the commit graph, so a
`plan.md` must be committed in a LATER commit than the `intent.md` it cites. Writing both in one commit fails
the gate — by design, because that is the shape a plan written after the diff takes. See `intent/README.md`.

**`pnpm agent-evals`** is the second stamp the push gate asks for. It is not part of `ci:local` and not in
CI; a push that CHANGES `CLAUDE.md`, `.claude/**` or `evals/**` is denied unless a green run has stamped HEAD
in `.git/everdict-evals-ok`. Editing a skill therefore costs one ~90s run before you can push it. Ordinary
pushes never meet the arm. See `evals/README.md`.

**`pnpm guardrails`** checks the push gate itself — that `.claude/settings.json` still wires it, and that
its decision still denies the seven cases it is supposed to. ⚠️ Its segmenter matches TEXT: writing a file
whose content contains a compound-command example of a push through a shell heredoc is denied by the gate,
because the heredoc body is part of the command string. Use an editor for those files.

Every push decision is recorded in `.git/everdict-gate-log.jsonl` with the ARM that fired, so "what has
this gate refused" is a query. `pnpm telemetry` collects the session facts no file can answer —
`docs/architecture/harness-observability.md` is the inventory of what the harness knows about itself.

See rule `ci.md` for the pushed critical rules.
