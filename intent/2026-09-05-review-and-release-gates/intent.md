# Intent: the two Deploy controls this repository states and does not enforce

Author: maintainer (via AI-native SDLC audit). Status: accepted

## Problem

Deploy is the weakest stage here and it is weak in a specific way: both of its controls are written down and
neither is enforced.

**Review.** `CLAUDE.md` opens with *"Review-first — load skill `code-review` before reviewing anything… No
exceptions"*, and the skill itself records that it has **failed twice and been paid for twice**. What fires it
is a person remembering to ask. There is no review policy file, no moment at which a review is required, and
no record that one happened — 2,710 commits in ninety days carried two merge commits, so there is not even a
pull request for a review to attach to. A control that has demonstrably failed twice, with nothing behind it,
is the definition this repository already uses for a law kept as prose.

**Release.** The repository ships by pushing a tag: `cli-v*`, `desktop-v*`, `api-v*`, `v*`. A tag push
publishes binaries and images to the public, and nothing is required first — no record of what is shipping,
no statement of what verified it, no moment where a person is asked to authorize rather than to type. The
release is the one act here with no undo, and it is the least gated thing in the tree.

Both are the same absence. Every other control in this repository refuses; these two ask.

## Proposed outcome

A review policy that lives in the repository as a file, applied identically to every push that carries
product code, with its findings recorded against the commit they were made about — and the push refused until
a review has RUN. Not until it is clean: findings inform a person, they do not approve. The gate asks whether
the question was put, which is the half that was missing.

A release tag cannot leave this checkout without a written authorization naming what ships, what verified it,
and who is authorizing — committed, so the record outlives the terminal it was typed in.

## Affected users and systems

A new `REVIEW.md`, `scripts/review/`, `releases/`, the push gate and its decision, `pnpm guardrails`,
`package.json`, `.claude/rules/ci.md`, skill `ci`, `docs/`.

## Constraints

- **A review that blocks on its own findings is not the article's control and not this repository's.**
  Findings rank and inform; the person decides. The gate requires that the review happened for this HEAD.
- **It may not tax every push.** Docs-only and intent-only pushes carry no product code and must not pay for
  a review. The cost has to land where the risk is.
- The review runs read-only, in a throwaway worktree, like the eval suite — an agent that reviews a tree it
  can edit has already stopped being a reviewer.
- **The release authorization is a settlement, so it names immutable things**: the tag, the commit, and the
  gates that were green. A record that says "looks good" settles nothing.
- No new bypass. Both stamps live where the existing ones live and are earned the same way.

## Open questions

- Should an Important finding require an explicit acknowledgement before the push? It would be stronger and
  it is not what the article describes. Left as it is until a finding is actually ignored.
