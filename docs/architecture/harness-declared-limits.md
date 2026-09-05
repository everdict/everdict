---
kind: decision
title: "Declared limits — the harness clauses this deployment cannot satisfy"
status: accepted
updated: 2026-09-05
---
# Declared limits — the harness clauses this deployment cannot satisfy

The AI-native SDLC audit scores each play on a ladder whose top two rungs are *enforced* and *measured*. Five
clauses cannot be satisfied here, and the reason is never that they are hard. Each is blocked by something
this deployment does not have: a second person, a managed device fleet, or a running production system.

This page exists because those five had been mentioned in passing across three commit messages and recorded
nowhere a reader could find them. **A limit that lives in prose somebody wrote once is a limit the next reader
rediscovers**, which is the same failure as a control nobody names — and this repository built a gate for that
one (`pnpm controls-documented`) in the same week.

Every entry says four things: the clause, why it is blocked, **what a reader must not conclude from its
absence**, and the condition that reopens it. A declaration with no reopening condition is a permanent excuse.

## The rule this page follows

A blocked clause is **not** a satisfied clause. Declaring it changes what the score means, not what the system
does: the play is scored at the rung it actually reaches, the blocked clause is named, and the grade says so.
Nothing here is a reason to stop trying — three of the five reopen the moment one fact about this project
changes, and two of those facts are plausible within a year.

---

## 1 · Branch protection requiring a code owner's approval

**Clause** — play `AI in the PR review loop`, L4: *branch protection requires a code owner's approval, and the
agent that wrote the code has no route to approve it.*

**Blocked by** — one maintainer. In ninety days this repository took 2,710 commits and two merge commits.
There is no second person, so there is nobody for a code owner to be who is not also the author.

**What its absence does not mean** — the second half of that clause **is** satisfied and by construction: the
reviewer runs in a throwaway worktree with every mutating tool denied and no write path to the repository, so
the thing that reviewed the code cannot approve it. What is missing is a human separation of duties, not a
technical one. `pnpm review` applies the same policy to every push carrying product code and the gate refuses
until it has run.

**Reopens when** — a second person can approve. At that point branch protection, `CODEOWNERS` and a required
check are ten minutes of GitHub settings, and this repository already has the `REVIEW.md` policy they would
enforce.

---

## 2 · Managed settings an individual cannot switch off

**Clause** — play `Hooks as build-time guardrails` / `Hooks as approval gates`, L4: *managed settings owned by
the platform or IT admin, where individual engineers cannot switch them off.*

**Blocked by** — no MDM and no admin console. Managed settings are deployed to a device fleet; there is no
fleet.

**What its absence does not mean** — the gate is not unguarded. `.claude/settings.json` is in git, and
`pnpm guardrails` refuses a tree where its PreToolUse block has stopped naming `pre-push-gate.mjs`, so removing
the wiring turns CI red rather than going unnoticed. That is enforcement by a different mechanism, and it is
weaker in exactly one way: an individual working outside the gate — pushing from another checkout, or from a
shell the hook does not see — is not stopped. The hook only guards this repository, from this tool.

**Reopens when** — the project is worked on by an organisation with a managed device policy. The settings keys
are documented in the article's worked example and would be a single file.

---

## 3 · Per-environment autonomy tiers, MCP-exposed deployment, and a rehearsed rollback

**Clause** — play `CI/CD integration and deployment`, L4: *per-environment autonomy tiers enforced by
configuration; deploy, status and rollback exposed as MCP tools scoped per environment; rollback the most
rehearsed path in the pipeline.*

**Blocked by** — nothing is deployed. This repository publishes artifacts (binaries on a tag, images to a
registry) and operates no running environment of its own. There are no environments to tier, no deployment to
expose, and a rollback path with nothing to roll back is a script that has never been true.

**What its absence does not mean** — the publish act is not ungated. `releases/<tag>.md` must be committed
before a release tag may leave, and it asks for the rollback command and where it has been rehearsed —
*"a rollback path that has never been run is a sentence."* The gate refuses the tag, not the deployment,
because the tag is what this project actually ships.

**Reopens when** — this project runs an environment. The release authorization already has the field waiting.

---

## 4 · Four of the eight containment-drill rows

**Clause** — Drill 3 rows 1, 2, 7 and 8: read a secret, reach a non-allowlisted domain from a shell, disable a
hook or sideload an unapproved skill, run below a version floor.

**Blocked by** — all four are properties of managed settings and OS-level sandboxing (see 2). Attempting them
without those in place measures nothing: they succeed, and their success says only that the controls are not
installed, which is already known.

**What its absence does not mean** — the gate-level rows (3, 4, 5, 6 — a direct push, an unauthorized release,
a protected path, a test file during a fix) have all been driven against the real hook, in both directions.
The drill is partial and reported as partial; a partial drill is not a passed one.

**Reopens when** — 2 reopens.

---

## 5 · "Gate violations reaching production, measured at zero"

**Clause** — play `Hooks as approval gates`, L4 lagging indicator.

**Blocked by** — no production, so the denominator is zero and the ratio is undefined. Reporting 0/0 as "zero
violations" would be the cleanest false certificate in this whole tree.

**What its absence does not mean** — the numerator is instrumented and waiting.
`.git/everdict-gate-log.jsonl` records every decision with the arm that fired, so the moment there is a
production to reach, the question has an answer rather than a project.

**Reopens when** — 3 reopens.

---

## What is NOT declared here

Three things that look similar and are not blocked, only unfinished. They belong in the backlog, not on this
page, and putting them here would be exactly the abuse this page's own rule warns about:

- **The eval suite's case count** — thirteen against a stated baseline of twenty to fifty. Work, not a wall.
- **Scan coverage** — one of eight scopes read at the time this was written. Work.
- **Baselines old enough to band on** — one full eval run, one scan, eleven gate decisions. Time, and the
  recording that makes time pay has already started.

## What would make this page wrong

Any entry whose reopening condition has been met and whose clause is still unsatisfied. That is the check to
run against it — not whether the prose is still accurate, but whether a fact about the project has changed
since it was written.
