---
name: ci
description: The push gate — pnpm ci:local is the ONLY pipeline this repository has (5 quality gates + cone/web-imports/empty-env-boot + self-contained web job + gitleaks; a PreToolUse hook blocks unstamped pushes). There is no remote CI and nothing to watch after a push. Use before committing/pushing, when the gate is red, or when editing the gate/hook scripts or the trust suite.
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
---
# CI (local parity before every push)

**The rule: never push red.** ⚠️ **There is no remote CI.** Every GitHub Actions workflow was disabled on
2026-08-21 and DELETED on 2026-09-11 (declared-limits C3), so `pnpm ci:local` is not a mirror of a pipeline —
it IS the pipeline, and a push is final the moment it lands. Nothing runs afterwards to catch what it missed.
The four "required checks" configured on `main` name workflows that no longer exist, so every push reports
"4 of 4 required status checks are expected"; that is expected and means nothing ran.

## The gate — one command
```bash
pnpm ci:local   # scripts/ci-local.mjs — the whole gate
```
On success with a **clean tree** it stamps `.git/everdict-ci-ok` with the HEAD sha. A dirty-tree
pass prints green but does NOT stamp (CI validates the pushed commit, not your working tree):
commit first, then re-run — turbo cache makes the re-run fast.

## Enforcement — the pre-push hook
`.claude/settings.json` wires a PreToolUse hook (`scripts/hooks/pre-push-gate.mjs`) that **denies
`git push`** (compound commands included) unless the stamp matches the current HEAD. Any commit
after the gate invalidates the stamp by construction. The hook guards every checkout that shares
THIS repo's `.git` — linked worktrees included, with cwd inside one or via `git -C` — and pushes of
other repos pass through. Never work around it (no stamp forging, no pushing outside the tool);
if it blocks you wrongly, fix the hook, don't dodge it.

## What the gate runs
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

## The suite the gate does NOT run — `pnpm trust-fast`
It needs a real Postgres, object store and ClickHouse, and booting three containers before every push is the
cost the local gate exists to avoid. Its rule is that a scenario which SKIPPED is a FAILED certification, so
it cannot be "run" by simply not having the infrastructure.

**`pnpm trust-certified`, inside `ci:local`, is what tells you it is owed** — it prints how long it has been
since anything certified and which files in scope have CHANGED since. The scope lives in `package.json`'s
`trust-fast` script and nowhere else; `pnpm trust-full` is the whole tree (Temporal additionally needs
`EVERDICT_TRUST_TEMPORAL`).

Touching a trust-suite subject (the commit ledger, the fences, settle, the receipt/attempt stores)? Run it
before pushing, against THROWAWAY containers — the suite migrates whatever database you give it:
```bash
docker run -d --name trust-pg --network bridge -e POSTGRES_PASSWORD=trust -e POSTGRES_DB=trust -p 55444:5432 postgres:16
docker run -d --name trust-minio --network bridge -e MINIO_ROOT_USER=k -e MINIO_ROOT_PASSWORD=s -p 59000:9000 minio/minio server /data
docker run -d --name trust-ch --network bridge -p 58123:8123 --ulimit nofile=262144:262144 clickhouse/clickhouse-server:24-alpine
docker port trust-pg   # ⚠️ sometimes EMPTY with the container UP — re-create, do not `docker start`
EVERDICT_TRUST_DATABASE_URL=postgres://postgres:trust@127.0.0.1:55444/trust \
EVERDICT_TRUST_CLICKHOUSE_URL=http://127.0.0.1:58123 \
EVERDICT_TRUST_S3_ENDPOINT=http://127.0.0.1:59000 EVERDICT_TRUST_S3_ACCESS_KEY=k EVERDICT_TRUST_S3_SECRET_KEY=s \
  pnpm trust-fast
```
A cold database times out TRUST-64 — run it twice before treating a lone timeout as red.
See `docs/trust-certification.md`.

## Failure protocol
1. **Your change broke it** → fix, re-run, push only on stamp.
   Fixes stay scoped to files you changed — never run repo-wide formatters here (shared WIP tree).
2. **Pre-existing failure** (someone else's WIP or an earlier commit) → it still blocks your
   push. Surface it to the maintainer; do not sweep others' files into your commit and do not
   push on top of red "because it wasn't me".
3. **Gate drift is gone as a failure mode.** There is no second list to drift from: `scripts/ci-local.mjs`
   is the only place a step exists. Adding a control means adding it there AND naming it in rule `ci`, which
   `pnpm controls-documented` refuses to let you skip.

## After pushing — there is nothing to confirm
No workflow runs, so the gate that ran BEFORE the push is the only thing that ever will. That is the whole
weight of `ci:local`: a step it does not run is a step nothing runs.

⚠️ One consequence worth holding: a locally-built `dist/` can mask a missing build step, and no clean-checkout
run exists to catch it any more. `pnpm ci:commits` builds each commit in a THROWAWAY worktree, which is the
closest thing left to a clean-environment check — run it, not just `ci:local`.

## The gates this page names only because they change how you work
**`pnpm intent-chain`** enforces the Plan→Build handoff from the commit graph, so a
`plan.md` must be committed in a LATER commit than the `intent.md` it cites. Writing both in one commit fails
the gate — by design, because that is the shape a plan written after the diff takes. See `intent/README.md`.

**`pnpm agent-evals`** is the second stamp the push gate asks for. It is not part of `ci:local` and not in
CI; a push that CHANGES `CLAUDE.md`, `.claude/**` or `evals/**` is denied unless a green run has stamped HEAD
in `.git/everdict-evals-ok`. Editing a skill therefore costs one ~90s run before you can push it. Ordinary
pushes never meet the arm. See `evals/README.md`.

**`pnpm guardrails`** checks the push gate itself — that `.claude/settings.json` still wires it (and the
SessionStart hook that starts the telemetry sink), that its decision still holds over fourteen cases, that
its scope reaches a real linked worktree (the hook driven in `--probe` mode), and that `watch-bands --dry-run`
refuses a fixture breach. **`pnpm fix-proof`** reads the rule that every fix ships a regression test (or
declares `Regression-test: none — <why>`), and `pnpm ci:commits` proves the test was red on the pre-fix code. ⚠️ Its segmenter matches TEXT: writing a file
whose content contains a compound-command example of a push through a shell heredoc is denied by the gate,
because the heredoc body is part of the command string. Use an editor for those files.

Every push decision is recorded in `.git/everdict-gate-log.jsonl` with the ARM that fired, so "what has
this gate refused" is a query. `pnpm telemetry` collects the session facts no file can answer —
`docs/architecture/harness-observability.md` is the inventory of what the harness knows about itself.

**`pnpm review`** is the third stamp. A push carrying `packages/**` or `apps/**` is denied until a review
has run for HEAD; it stamps on completion, not on cleanliness, so findings are yours to judge. A push whose
HEAD carries a release tag needs `releases/<tag>.md` committed first — see `releases/README.md`.

See rule `ci.md` for the pushed critical rules.
