# `intent/` — where a change starts

An idea enters the repository here, in the originator's own words, as a version-controlled artifact the
next stage can act on. One directory per change:

```
intent/<YYYY-MM-DD>-<slug>/
  intent.md    what is wanted, why, under which constraints   (required)
  spec.md      the requirements + design pass over it         (optional)
  plan.md      the implementation plan, before any code       (optional, but see below)
```

`intent/TEMPLATE.md` and `intent/PLAN-TEMPLATE.md` are the shapes. `pnpm intent-chain` enforces them.

## Why this exists

Before this directory, an idea reached the code as a commit message. The commit messages in this repository
are unusually intent-shaped — *"a question the grader could not ask was being spent as the agent's wrong
answer"* — but they are written **after** the work. There was no artifact anyone could review, contradict, or
plan against while changing course was still a matter of editing a document, and no record of an idea that
was considered and rejected. The chain here runs the other way round: `intent.md` → `spec.md` → `plan.md` →
the diff and its tests.

## The ordering rule, and why it is checked

A plan written after the diff is not a plan, it is a description that agrees with itself. So the chain is
enforced by commit order, not by good intentions:

- `intent.md` is introduced in a commit **no later than** its `plan.md`.
- `plan.md` cites the intent it came from: `From: intent.md @ <sha>`, and that sha is the commit that
  introduced the intent.
- `Status: shipped` carries `Shipped: <sha>`, and that commit is **strictly later** than the plan.

Each of the three is a claim the git history can refuse. `scripts/check-intent-chain.mjs` asks it.

## Status

`draft` → `accepted` → `shipped`, or `rejected`. The accept/reject decision is the Plan-stage gate: an
accepted intent is what starts the design pass, and a rejected one stays in the tree with its reason, because
the ideas that were turned down are half of what an intent home is for.

## What this is NOT

Not a ticket tracker, not a backlog, and not a place for work already decided and understood. A one-line
fix does not need an intent — the test is whether someone other than the author would need to reconstruct
*why* six months from now. When in doubt, `docs/architecture/` holds the decision records; this holds the
requests that lead to them.
