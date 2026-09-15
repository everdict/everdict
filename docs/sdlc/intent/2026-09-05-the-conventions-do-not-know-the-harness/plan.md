# Plan: point the conventions at the harness

From: intent.md @ fbb3be84c147340fb4acf9e6985d13ef5ae33f3d

## Files that change

- `.claude/skills/foundation/SKILL.md` — the gates a change meets, in the order it meets them.
- `.claude/skills/documenting/SKILL.md` — where `intent/` and `releases/` sit against the three layers.
- `.claude/skills/testing/SKILL.md` — `evals/` is a suite, and it is not Vitest.
- `.claude/skills/evaluation/SKILL.md` — the two meanings of "eval", separated in one paragraph.
- `.claude/skills/code-review/SKILL.md` — it has an enforcer now, and `REVIEW.md` is what it applies.
- `CLAUDE.md` — the new top-level directories, one line each.
- `docs/README.md` — index `intent/` and `releases/`.

## Order of work

1. `code-review` first: it is the skill whose failure started this, and `REVIEW.md` being unreferenced is the
   sharpest instance.
2. `documenting`, because it is the procedure the rest are placed BY. `intent/` is a request, not a record —
   the test is whether the thing is asking for work or describing a decision already made.
3. `foundation`, `testing`, `evaluation`: one paragraph each, pointing rather than copying.
4. `CLAUDE.md` and `docs/README.md`.

## Risks

- **Copying instead of pointing.** Rule `ci` is the record; anything restated here is a second thing to keep
  true, and `documenting` itself says the same knowledge in two layers has already diverged. Every addition
  is a sentence and a path.
- **CLAUDE.md growth.** It is a map and its size is load-bearing. Three lines, for three directories that
  change what a reader does.
- `docs-check` will refuse any path or symbol these additions cite that does not exist, which is the point.

## Proof

- `grep -rl REVIEW.md .claude/` is non-empty.
- Each of the five skills names at least one control that applies to the work it describes.
- `pnpm docs-check`, `convention-harness`, `intent-chain`, `lint` green.
