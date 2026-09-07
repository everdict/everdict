# Plan: the review gate and the release authorization

From: intent.md @ 8444d6662a9c1dfbe307afb4b5b646e1b2e67488

## Files that change

- `REVIEW.md` (new) — the passes, what Important means here, the nit cap, what to skip.
- `scripts/review/run.mjs` (new) — `pnpm review`: the range, the policy, a throwaway worktree, read-only.
- `releases/README.md` + `releases/TEMPLATE.md` (new) — the authorization's shape.
- `scripts/hooks/gate-decision.mjs` — two arms: `review-missing`, `release-unauthorized`.
- `scripts/hooks/pre-push-gate.mjs` — the two facts: does the push carry product code, does HEAD carry a
  release tag.
- `scripts/check-guardrails.mjs` — the truth table grows to cover both arms in both directions.
- `package.json`, `.claude/rules/ci.md`, `.claude/skills/ci/SKILL.md`, `docs/README.md`.

## Order of work

1. `REVIEW.md`, from skill `code-review`'s passes. It is the artifact the reviewer reads, so it exists before
   anything runs.
2. `pnpm review`: diff the push range, run one non-interactive session with the policy and the diff, parse a
   findings envelope, write `.git/everdict-review-<head>.json`, print the findings ranked, stamp
   `.git/everdict-review-ok` on completion — **on completion, not on cleanliness.**
3. The gate's review arm, fired only when the range touches `packages/**` or `apps/**`.
4. The release arm: `git tag --points-at HEAD` filtered to the release patterns; each matching tag needs
   `releases/<tag>.md` committed, carrying the tag, the commit, and the gates that were green.
5. Both arms into the truth table, in both directions — an arm that only ever denies is not shown to be
   selective.
6. Prove each by driving the hook, and prove the review actually reviews by running it over this branch.

## Risks

- **A review nobody reads is a tax.** The findings print at the terminal ranked by severity, and the file is
  named in the stamp line; if that turns out not to be read, the next step is the acknowledgement the intent
  leaves open, not a louder message.
- **Cost.** One session per push that carries product code. Docs and intent pushes pay nothing, which is most
  of the pushes this session produced.
- **A tag pushed from a checkout that never authorized it.** The arm reads tags pointing at HEAD, so a tag
  created elsewhere and pushed from here is caught too.
- **The release record could be written to satisfy the gate.** It names the tag, the commit and the gate
  results — things that are checkable — rather than a judgement, so a false one is a false statement about
  facts rather than an opinion.

## Proof

- `pnpm review` over this branch produces ranked findings and a stamp; the findings file parses.
- Product-code push without a review stamp: DENY naming the review; with it: falls through.
- Docs-only range: the review arm does not fire.
- HEAD carrying `api-v9.9.9` with no `releases/api-v9.9.9.md`: DENY; with the file: falls through. Tag removed after.
- `pnpm guardrails` covers both arms in both directions; `pnpm lint`, `docs-check`, `intent-chain` green.
