# Plan: move the module map out of the always-loaded layer

From: intent.md @ 7bb282eefdd54db9c72856323d160df727740a9e

## Files that change

- `CLAUDE.md` — the `## Architecture` section only. Its 56 lines are the largest block in the file and, as
  measured, **not one of them is a sentence an eval case holds as a subject**: the eight cases that name
  `CLAUDE.md` fingerprint the commands section, the critical rules, the language policy, the docs-first
  paragraph and the empty-corpus rule — every one of which stays. The spine diagram, the layer-spine
  sentence, the "reverse imports are bugs" line and the intra-package layout rule stay; the per-package
  paragraphs go, replaced by a pointer.
- `.claude/skills/foundation/references/architecture.md` — receives whatever the per-package paragraphs carry
  that this file does not already have. It already holds the same table for most packages; the delta is the
  packages added since it was written.
- `.claude/skills/foundation/SKILL.md` — only if its `Topic map → references` line needs to name the moved
  content so the pull layer can still find it.

## Order of work

1. **Diff the two maps first, and move the delta INTO foundation before removing anything.** List the
   packages CLAUDE.md documents and the ones `references/architecture.md` documents; anything only CLAUDE.md
   has (`llm`, `otel`, `images`, `datasets`, `agent-runtime`, `sdk`, `apps/agent` are the likely set) is
   written into the reference first. Nothing is deleted until its content exists in the other layer.
2. Replace CLAUDE.md's per-package paragraphs with the spine diagram, the layer-spine sentence, and one
   pointer to skill `foundation`. Keep the deviation note about interfaces, which is a convention rather
   than a map.
3. `pnpm docs-check` + `pnpm convention-harness` — the first verifies every backticked symbol CLAUDE.md still
   names is live and every path resolves; the second that the rules CLAUDE.md references still exist.
4. Re-drill the cases whose subject is `CLAUDE.md`, because the file they are neutralized against changed:
   `backends-never-run-the-harness`, `biome-write-is-not-evidence`, `compute-handle-in-a-finally`,
   `docs-first`, `empty-corpus-is-not-a-pass`, `english-only-source`, `skipped-scenario-is-not-passing`,
   `ci-local-before-push`. A drill that flips from red to green means a sentence the suite was measuring left
   the file — that is the failure this step exists to catch, and the repair is to put it back.
5. Record the before/after size in the commit message, because "shorter" without the number is the adjective
   this repository refuses elsewhere.

## Risks

- **The map stops being loaded and a session designs without it.** This is the real cost and it is the whole
  trade: the map moves from PUSH (always in context) to PULL (skill `foundation`, matched on its description).
  The mitigation is that the spine diagram — which package may import which — stays in CLAUDE.md, and that is
  the part a session must not get wrong silently. The detail behind each package is what a session looks up.
  If a later review finds a layering violation whose cause is the missing map, this change is the suspect and
  the intent's falsifier has fired.
- **A moved sentence is a lost sentence.** Step 1 orders the work so content lands in foundation before it
  leaves CLAUDE.md; step 4 asks the eval suite whether anything load-bearing went missing anyway.
- **`docs-check` symbol drift.** CLAUDE.md's backticks are checked against live source; removing text cannot
  break that, but the pointer must not invent a path.

## Proof

- Every one of the eight neutralize strings still greps in `CLAUDE.md` after the edit.
- `pnpm docs-check`, `pnpm convention-harness`, `pnpm lesson-evals`, `pnpm controls-documented` green.
- The eight CLAUDE.md-subject cases still drill RED (or the sentence is restored and the drill re-run).
- Word count before and after, stated in the commit.
