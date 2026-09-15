---
paths: "**/*"
---
# CI rules (push) — never push red

The recipe is skill `ci`. Why each control exists, and the incident behind it, is `docs/sdlc/gates.md`.
This page is only what must not be forgotten at the keyboard.

## The gate
- **NEVER `git push` before `pnpm ci:local` passes.** There is no remote CI — every GitHub Actions workflow was
  deleted on 2026-09-11 (C3 in `docs/sdlc/declared-limits.md`) — so `ci:local` IS the pipeline, a push is
  final the moment it lands, and there is nothing to watch or confirm afterwards.
- **Every commit in a push, not only its tip.** `pnpm ci:commits` runs lint+typecheck+test on each commit ahead
  of the remote in a throwaway worktree; then `pnpm ci:local` stamps HEAD on a clean tree. Committing after the
  gate invalidates the stamp — re-run it (turbo cache makes that fast).
- **The hook enforces it.** `scripts/hooks/pre-push-gate.mjs`, wired in `.claude/settings.json`, guards every
  checkout that shares this `.git`, linked worktrees included. Never work around it — no stamp forging, no
  pushing from outside the tool; if it denies wrongly, fix the hook. Its segmenter matches TEXT, so writing a
  file whose content quotes a push after a shell separator through a heredoc is denied: use an editor.
- **A push can owe three more stamps**, refused by the same hook:
  - it changes `CLAUDE.md`, `.claude/**`, `docs/sdlc/gates.md` or `scripts/evals/**` → `pnpm agent-evals`
    green for HEAD;
  - it changes `packages/**` or `apps/**` → `pnpm review` completed for HEAD (the policy is `REVIEW.md`);
  - HEAD carries a release tag → `docs/sdlc/releases/<tag>.md` committed.
- **Every `fix:` ships its regression test.** A fix under `packages/**` or `apps/**` changes a `*.test.ts` or
  declares `Regression-test: none — <why>` (`pnpm fix-proof`), and `pnpm ci:commits` proves the test is RED with
  the source reverted to the parent.
- **A document is owned by the change that makes it false.** Changing a file that a guide, reference, runbook
  or preflight page lists in `anchors:` means editing that page in the same push or adding
  `Docs-unchanged: <doc> — <why>` to a commit body (`pnpm doc-anchors`); `docs/architecture/**` is listed as
  advisory — read it, it is not refused. New or rewritten pages anchor the files that DEFINE what they describe — never a
  composition root or a hot service file unless the page is about it.
- **A failure you did not cause still blocks your push.** Surface it to the maintainer; never absorb or bypass it.

## What a green gate does not say
- **A trust scenario that SKIPS is not a passing one, and skipping is the local default.** Without
  `EVERDICT_TRUST_SUITE=1` every `*.trust.test.ts` is `describe.skip` and `pnpm test` exits 0; the
  infrastructure URLs only choose what a scenario drives once inside that gate, so setting them alone still
  skips everything. `pnpm trust-certified` (inside `ci:local`) prints how long since anything certified and
  what changed since. A change to a trust-suite subject runs `pnpm trust-fast` before pushing, against
  THROWAWAY containers — the suite migrates whatever database it is given. See `docs/trust-certification.md`.
- **`biome check --write` does not apply Biome's unsafe fixes, and exits 0 anyway.** Running the formatter is
  not evidence; `pnpm lint` afterwards is. Lint is check-only and safe repo-wide; FIXES stay scoped to the files
  you changed — never run a repo-wide formatter in this shared tree.
- **`pnpm protocol-mutations` is author-run, not a gate** (`--only <rung>` takes seconds). While it runs it
  mutates production files: stage by explicit file list, never `git add` a directory, and read back
  `git diff --cached --name-only` before committing (`pnpm mutation-leak` catches what slips). After killing it,
  run `git diff HEAD --name-only` and restore what it names. Never `import()` it to check syntax — that RUNS it;
  `node --check` does not.
- **The permission deny list is a speed bump, not containment.** Denying the `Read` tool on `~/.ssh` does not
  deny `cat` through Bash; the declared-limits page says so.

## Changing the gate itself
- A new control is added to `scripts/ci-local.mjs` AND named in `docs/sdlc/gates.md` with the incident that
  produced it — `pnpm controls-documented` refuses one that is not.
- A new `scripts/check-*.mjs` refuses to report over an empty corpus and declares what it watches
  (`pnpm scanner-watches`). A red one is explained by `pnpm triage <gate>`, which reads the scanner's header.
- Moving or renaming a package re-points its rule's `paths:` in the same change (`pnpm convention-harness`), and
  moving a file that a document, rule or skill cites updates the citation (`pnpm docs-check`).
