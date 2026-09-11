---
kind: decision
title: "Declared limits — harness clauses this deployment cannot satisfy, and the ones it declines"
status: accepted
updated: 2026-09-07
---
# Declared limits — clauses this deployment cannot satisfy, and the ones it declines

The AI-native SDLC audit scores each play on a ladder whose top two rungs are *enforced* and *measured*. Five
clauses cannot be satisfied here and the reason is never that they are hard: each is blocked by something this
deployment does not have — a second person, a managed device fleet, or a running production system. Four more
are different in kind and have their own section at the bottom: nothing is missing, and the project declines
them. One play does not apply at all, and is declared so at the very end.

This page exists because those five had been mentioned in passing across three commit messages and recorded
nowhere a reader could find them. **A limit that lives in prose somebody wrote once is a limit the next reader
rediscovers**, which is the same failure as a control nobody names — and this repository built a gate for that
one (`pnpm controls-documented`) in the same week. The second audit (2026-09-06) found three more positions
in exactly that state — in an intent's constraints, in a README, and in nobody's writing at all — and they are
the entries C2–C4 and the N/A below.

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
enforce. Note that today GitHub's own protection is inert for the sole maintainer regardless: `enforce_admins`
is off, and the four required checks name workflows that are disabled (C3).

---

## 2 · Managed settings an individual cannot switch off

**Clause** — play `Hooks as build-time guardrails` / `Hooks as approval gates`, L4: *managed settings owned by
the platform or IT admin, where individual engineers cannot switch them off.*

**Blocked by** — no MDM and no admin console. Managed settings are deployed to a device fleet; there is no
fleet.

**What its absence does not mean** — the gate is not unguarded. `.claude/settings.json` is in git, and
`pnpm guardrails` refuses a tree where its PreToolUse block has stopped naming `pre-push-gate.mjs`, so removing
the wiring turns the gate red rather than going unnoticed. That is enforcement by a different mechanism, and it
is weaker in exactly one way: an individual working **outside the tool** — a shell the hook does not see — is
not stopped. The hook guards every checkout that shares this repository's `.git`, from this tool.

⚠️ Until 2026-09-06 this entry said "pushing from another checkout" and filed a linked worktree under it. That
was wrong: a linked worktree is the same tool, the same settings and the same session, and the hook compared
toplevels, so a push from one exited it silently with no ledger line. The second audit found it with two
synthetic payloads; the scope is the common git directory now, and `pnpm guardrails` drives the hook against a
real linked worktree on every run. What remains under this entry is the shell outside the tool, and nothing
else.

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

**What its absence does not mean, and what this entry used to claim.** The first version of this page said the
gate-level rows (3, 4, 5, 6) had "all been driven against the real hook, in both directions". The second audit
drove them and found that sentence true for row 4 (an unauthorized release, refused three times with the
reason), true at the push and not at the edit for row 5 (a change under `CLAUDE.md`, `.claude/` or `evals/` is
refused without a fresh eval stamp; the edit itself is not stopped, and generated paths are not protected at
all), true for row 3 except through a linked worktree (see 2, repaired), and **not true for row 6**: nothing
read a test file during a fix, and the row was stopped by attention alone. Row 6 has a mechanism now, in this
repository's own form rather than the playbook's — see C-row-6 below — and the certificates that record what
was driven are on `harness-drill-certificates.md`. The drill is partial and reported as partial.

**And what the deny list does not mean.** `.claude/settings.json` grew a `permissions.deny` half —
`Read(.env*)`, `Read(~/.ssh/**)`, `Bash(curl *)` and five more. It reads like the repair for rows 1 and 2 and
it is not one: `Read(~/.ssh/**)` denies the `Read` TOOL while `cat ~/.ssh/id_rsa` through `Bash` reaches the
same bytes, and `Bash(curl *)` denies two literal prefixes while `python3 -c "import urllib.request…"`, `nc`
and WebFetch reach the same hosts. A bound composed with an unbounded neighbour, which is the class this
repository names for its own scanners. Enumerating more spellings does not close it — the neighbour is a
general-purpose shell, and that is exactly why rows 1 and 2 are declared here rather than fixed. The deny
list stops the accidental read and the absent-minded fetch, which is worth having and is not this clause.

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

# Chosen limits — clauses this project declines

The five above are blocked: a person, a fleet or a deployment is missing, and each reopens when that fact
changes. These are different in kind and must not be filed with them. **Nothing is missing; the project
declines the clause**, and it reopens only if the project changes its mind.

Keeping the two apart is the whole point of this section. A blocked limit is a fact about the world; a chosen
one is a position, and a position that hides among facts stops being arguable.

## C1 · An implementation with no `plan.md` is not refused

**Clause** — play `Claude Code plan mode as the default starting point`, L4: *an implementation PR with no
`plan.md` is blocked.*

**Declined because** — `intent/README.md` says it in its own words: *"A one-line fix does not need one; the
test is whether the reason survives in the commit message alone."* A gate that demands a plan for every change
would demand one for a typo, and the first repair anybody reaches for is a plan that says nothing — which is
worse than no plan, because it passes.

**What its absence does not mean** — plan mode is not optional in practice and is not unenforced where it
matters. Twelve of the twenty change directories carry a `plan.md`; every one of them cites the commit that
introduced its intent, and `pnpm intent-chain` refuses a plan that does not descend from it. What is unenforced
is the *requirement to have one at all*, and that is the part this project decided belongs to judgement. The
second audit measured the other side of that judgement: 9 of the 41 product-code commits in its window were
the Shipped target of an intent, and one 445-file change went without a plan.

**Reopens if** — a change ships without a plan and the missing plan is what let a defect through. That is the
evidence this position is wrong, and it has not happened yet. Until then the position stands on the article's
own framing: the gates are for what a person reliably gets wrong, not for what a person reliably decides.

## C2 · A spec is not required for every intent — it is a decision recorded per intent

**Clause** — plays `Capture as intent.md` (L3) and `Requirements and design` (L3): *a merge into the intent
home triggers the design pass with no human input.*

**Declined because** — the same argument as C1, one stage earlier: not every change needs a requirements pass,
and a gate that insists otherwise is routed around within a week. Until 2026-09-06 this position lived in
`intent/README.md` and in a shipped intent's constraints, and the audit scored both plays at L2 because the
handoff was a start button somebody had to press and nothing distinguished "declined" from "not picked up".

**What its absence does not mean** — the third state is refused now. An accepted intent has a `spec.md`, or
one line — `Design: none — <why>` — and `pnpm intent-chain` refuses an accepted intent with neither. The
person's decision is recorded; the person's *memory* is no longer in the path, because the gate asks. What is
declined is only the clause that a spec be produced for every intent unconditionally.

**Reopens if** — a change that declined its design pass ships a defect the pass would have flagged as an area
of concern. Then the declaration was the wrong shape, and the trigger should be unconditional.

## C3 · Remote CI is switched off, and the local gate is the pipeline

**Clause** — play `CI/CD integration and deployment`, L3: *judgment steps run non-interactively in the
pipeline*; and the wording of rule `ci` and skill `ci`, which tell a session to confirm a remote run went
green.

**Declined because** — every GitHub Actions workflow in this repository has been `disabled_manually` since
2026-08-21 09:25 KST. At this project's cadence (roughly 2,700 commits per ninety days) a full remote run per
push is a cost the maintainer chose not to pay, and the local gate refuses before anything leaves the machine,
which is the stronger place. The audit skill's own table accepts a stamp ledger plus a push gate plus a check
over the gate's wiring as the enforcement point without a runner.

**What its absence does not mean** — nothing is ungated. `pnpm ci:local` mirrors `ci.yml` step for step and
stamps a ledger; the push hook refuses an unstamped push; `pnpm guardrails` refuses a tree where the hook is
unwired. What IS true, and was not written down anywhere until the second audit read it off the GitHub API:
the four "required status checks" on `main` name workflows that never run, `enforce_admins` is off, and 378
first-parent commits reached `main` between the last remote run and the audit with no remote check. Rule `ci`
and skill `ci` no longer instruct a session to watch a run that will not exist; they say to check the workflow
state first.

**What its absence DID mean, once, measured** — `trust-fast` is a required check this entry silenced, and
`ci:local` cannot substitute for it: it boots no Postgres, object store or ClickHouse by design, so every
`*.trust.test.ts` SKIPS and vitest reports a skip and a pass with the same exit code. On 2026-09-10 six
certifications were found red — five asserting a whole `Score` against a shape that had grown a key, one
sealing a receipt over bytes the row would never hold — after days in which `pnpm test`, `pnpm ci:commits`
and `pnpm ci:local` were all green over them. Nothing anywhere could say how long it had been since anything
ran them. See `lessons/2026-09-10-five-certifications-went-red-and-pnpm-test-said-green.md`.

**What now makes the gap visible** — `pnpm trust-certified`, wired into `ci:local`, prints the scenario count
in the required check's scope (parsed out of `trust-fast.yml`, never copied beside it), the last
certification's sha and date, and which files in that scope have CHANGED since. It does not run them and does
not fail on them — three containers inside the push gate is the cost declined above, and a gate needing
infrastructure it cannot start teaches people to bypass gates. It is red only on scope drift. ⚠️ **It is the
fallback, not the repair, and shipping it is what records that this entry STAYS.** The repair is
`gh workflow enable`.

**Reopens if** — a red `main` reaches the remote that the local gate would have refused — which can only
happen from a shell outside the tool (entry 2) — or the maintainer re-enables the workflows, at which point
this entry is superseded, the "confirm green" instruction is unconditional again, and `pnpm trust-certified`
becomes a redundant reader rather than the only one. `gh workflow enable` is one command per workflow.

## C4 · A dry run of the bands refuses; it does not file

**Clause** — play `Maintenance and closing the loop`, L3: *a deterministic detection script puts an
`intent.md` in the triage queue with no person in the path.*

**Declined because** — `pnpm ci:local` reads the bands on every full run, and until 2026-09-06 it did so in a
dry run that exited 0 on a breach: detection with no person, filing with one, and the push never waited for
the second half. The alternative — filing from inside the gate — writes into the tree the gate is checking,
which is the eval runner's first recorded incident one layer up, and reopens the loop this repository already
closed once for `evals/history.jsonl` (a run dirties the tree, a dirty tree refuses the stamp). So the gate's
dry run REFUSES at 3σ, names the command, and the push waits until `pnpm watch-bands` has filed the intent and
it is committed. The person's only decision is gone; their hands are still on the one command.

**What its absence does not mean** — the filing is not a person's judgement. The intent is written from a
template with no model in the path, and an open intent for the same metric on any date lifts the refusal.
The escape from a refusal is the one the filed intent already offers: fix the cause, or retune the band with
the reason committed. That a real band can be retuned away under time pressure is the same tension C1 accepts
for `plan.md`, and it is named here so it is argued rather than discovered during the first real breach.

**Reopens if** — the gate's dry run is found refusing on a breach whose intent could not be filed for a reason
the person did not choose — then the refusal was a wall, and filing must move inside the gate after all.

## C-row-6 · The playbook's lock on test files during a fix is declined; the property it protects is proved

**Clause** — Drill 3 row 6 and play `Give Claude a feedback loop`, L4: *test files are locked during fix
tasks.*

**Declined because** — the lock prevents an agent from making a test pass by editing it. This repository's rule
runs the other way: a fix must ADD a test, and the test must have been red on the pre-fix code. A lock would
forbid the thing the rule requires. The property both are after is the same — the test was red before and
green after — and it is provable from the commit graph, which is where `pnpm fix-proof` (the rule: a fix under
`packages/**` or `apps/**` carries a test or declares `Regression-test: none — <why>`) and `pnpm ci:commits`
(the proof: source reverted to the parent, the commit's tests run, red required) prove it.

**What its absence does not mean** — the rule applies to commits newer than the check, because history is not
rewritten here; the 29 fix commits on the branch before it are outside it, and none of them touched a test
file under Vitest anyway (their proof is a truth table under `scripts/`).

**Reopens if** — an agent makes a fix's test green by editing the test in the same commit in a way the proof
does not catch (the proof reverts SOURCE hunks and keeps the test at the commit; a test that is red on the
parent for a reason unrelated to the fix would pass it). Then the lock is the cheaper control after all.

## The rule for this section

An entry here needs an argument, not a blocker. It also needs a falsifier — the observation that would show
the position wrong — because a declined clause with no falsifier is indistinguishable from a clause nobody
wanted to build.

---

# Not applicable — plays that structurally cannot apply here

## p16 · Claude on call (channel on-call)

N/A: no chat platform is connected to this repository's own operation, and incidents arrive as gate
refusals, review findings, scan findings and commits — never as a message in a channel. (The product ships a
Mattermost integration; that is a feature for tenants, not where this project's incidents start.)

Reopens if: a team channel becomes where incidents start — which is the same fact that reopens entry 1.

Buildable half, and built: post-mortems are committed to a version-controlled home (`lessons/`, seven
entries with real history), each declaring the eval case it produced or why it produced none, read by
`pnpm lesson-evals`.

---

## What is NOT declared here

Things that look similar and are not blocked, only unfinished. They belong in the backlog, not on this page,
and putting them here would be exactly the abuse this page's own rule warns about:

- **The eval suite's case count** — four against a stated baseline of twenty to fifty, and this entry is the
  one that changed character. It was filed as "work, not a wall" when the suite held twenty cases nobody had
  drilled. Two complete drill-alls later, eleven are retired: the gap between what a capable model does by
  default and what this repository requires is simply narrower than twenty cases wide. That is a measured
  fact, not a backlog item — but it is still not a declared limit, because the honest response is to find
  more places where the gap is real (each incident is a candidate) rather than to accept four. What would be
  a limit, and is not claimed yet: that this repository has fewer than twenty such places at all.
- **The second scan rotation** — every scope read once; the trend needs a second pass. Work.
- **Baselines old enough to band on** — three of four bands compute now; L5 needs two quarters of movement,
  so no play can claim it before 2027-03. Time.
- **`CLAUDE.md` at eight pages** — `intent/2026-09-06-claude-md-is-eight-pages/`, a draft. Work, and a
  judgement the eval suite has to referee.

## What would make this page wrong

Any entry whose reopening condition has been met and whose clause is still unsatisfied. That is the check to
run against it — not whether the prose is still accurate, but whether a fact about the project has changed
since it was written.
