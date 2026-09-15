From: intent.md @ 7bb282eefdd54db9c72856323d160df727740a9e
Policies: aa8ba246669a0440be9631af15de891ef081dcf3
Concerns: resolved — each one settled below, in "Concerns, settled"; three shaped the implementation (cross-date dedupe, the digest on a drill certificate, the restore in its own finally) and two were declined with the reason.

<!-- Written by `pnpm design` from intent.md, model sonnet, 2026-09-06T03:09:01.199Z.
     A machine proposed this. It is in the working tree and committed by nobody; read it before a plan is
     written against it, and edit it freely — the intent chain applies to this file exactly as to a person's. -->

## Requirements

1. **The push gate guards every checkout that shares this repository's `.git`, not only one whose toplevel equals the main working directory.** A push run with `cwd` inside a linked worktree, or via `git -C <worktree> push`, is recognized as "this repo" and subjected to the same ledger checks as a push from the main tree.
2. **The worktree fix is checkable without letting a probe decide or record.** The "same repo" test is extracted as a pure, importable predicate (no ledger reads, no `decideGate`, no `appendFileSync`) so a check can drive it against a real linked worktree and assert `true`/`false` without exercising the gate's decision or write path.
3. **A 3σ band breach refuses `pnpm ci:local` unless the intent it proposes already exists.** `watch-bands --dry-run`, on a 3σ tier, exits non-zero when no `intent/*-band-<slug>/intent.md` for that metric exists yet (checked across ALL dates for that metric slug, not only today's), and exits 0 when one already does — filing itself stays a `--dry-run`-only side-effect-free read, never a write performed inside `ci:local`.
4. **1σ and 2σ tiers are unchanged** (log-only; read-only diagnosis respectively) — only the 3σ exit code changes, and only in `--dry-run` mode; a real (non-dry-run) `pnpm watch-bands` run keeps writing the intent as it does today.
5. **An accepted intent is either designed or says in one line why not, and the third state is refused.** `intent-chain` currently reports a spec-less accepted intent as a NOTE forever; it must instead FAIL unless the intent declares a one-line field (parallel to `Rejected: <why>`) stating why no design pass is needed.
6. **A `fix:` commit under `packages/**`/`apps/**` that changes both a test file and a source file must prove the test was RED on the pre-fix code**, driven inside `scripts/ci-commits.mjs`'s existing per-commit throwaway worktree — no new worktree, no new network or infra cost.
7. **A `fix:` commit with no test-file change carries a one-line declaration of why not** (parallel to `Rejected:`/the new spec-declination field), checked by the same script; a commit with neither a test change nor a declaration fails the commit gate.
8. **The fix-proof rule applies only to commits that land after the check itself lands** — it names its own landing commit and skips any commit that is not a descendant of it, so history is never rewritten and no existing citation breaks.
9. **A cross-package fix-proof rebuilds the dependency's `dist` before running the test**, when the reverted source file and the test file live in different workspace packages (tests import siblings through `dist`, per existing convention).
10. **Every `--drill <id>` (and `--drill-all`) run appends one ledger line** to a local `.git`-scoped ledger recording id, timestamp, and pass/fail — mirroring the existing gate-log/review-log pattern — so a future control band can read drill health as a series.
11. **A passing drill also updates a COMMITTED certificate** naming the case, the date, and a digest of its subject files, so the next audit can read drill history without replaying the drills.
12. **`--drill-all` exists** and runs every declared case's drill in sequence, reporting per-case pass/fail and failing the process if any drill fails to go RED.
13. **A `neutralize` string that also appears verbatim in a tracked file NOT listed in a case's `subject` is refused at load**, unless that file is explicitly declared as an allowed echo with a stated reason — closing the exact hole where a lesson survived a drill by living in `evals/README.md`/`lessons/*.md` as well as its declared subject.
14. **Three positions get written onto `docs/architecture/harness-declared-limits.md`, each with a falsifier**: (a) 3σ auto-filing does not run inside `ci:local` itself (it would reopen the same dirty-tree, no-exit loop this repo already fixed for `evals/history.jsonl`); (b) GitHub Actions remains declared OFF rather than switched on, and the local gate is stated as the whole pipeline; (c) the fix-proof rule is going-forward-only by design, not a retroactive audit.
15. **§4 of the declared-limits page is corrected to say what is now true**: row 6 (a test file edited during a fix) has a real mechanism once the fix-proof check exists, and the page must stop saying it does not.
16. **`.claude/rules/ci.md`'s closing line ("confirm the run went green") is qualified**: it applies to a remote run that exists; while GitHub Actions is declared off, the local gate's own green is the confirmation, and the rule says so instead of pointing at a pipeline that never runs.
17. **A session starts its own telemetry collector** rather than depending on a person remembering a second terminal — idempotent against a port already listening, and it must not block or fail session start if a collector is already up.
18. **None of the above may add a new bypass, slow down a green run, or rewrite history** — each mechanism above is designed against this constraint explicitly (see Design).
19. **Every new/changed control is named by `pnpm controls-documented`'s reach**: `.claude/rules/ci.md`, `CLAUDE.md`, and the docs index gain the matching lines in the same change that ships the control, in the same PR.

## Design

This is entirely a change to the harness's own tooling (`scripts/**`, `.claude/**`, `intent/**`, `docs/architecture/**`) — no `packages/**` or `apps/**` product code, no contracts crossed between the layered spine. It does, however, land under `scripts/`, which `PRODUCT_PATHS` in `gate-decision.mjs` already includes — so this change is "product code" for gate purposes and needs `pnpm review` before push, same as any other.

**1–2. Worktree-aware gate.**
`scripts/hooks/gate-decision.mjs` gains an exported pure predicate, e.g. `sharesGitDir(effectiveCwd, root)`, replacing the current `toplevel === root` comparison in `pre-push-gate.mjs` with a comparison of `git rev-parse --path-format=absolute --git-common-dir` resolved from `effectiveCwd` against the same resolved from `root`. A linked worktree's toplevel differs from the main tree's, but its common git dir is identical — that is the fact the current code fails to ask for. `check-guardrails.mjs` (or a small dedicated probe module) drives this predicate directly: `git worktree add --detach` a real temporary linked worktree of the current repo, assert the predicate is `true` from inside it, and `false` from an unrelated `mkdtemp` directory — never calling `decideGate`, never touching `.git/everdict-gate-log.jsonl`. This satisfies "decides nothing and records nothing" by construction: the probe never reaches the code path that decides or writes.

**3–4. Band refusal without filing inside the gate.**
`scripts/bands/watch.mjs`'s 3σ branch, when `opts.dryRun` is true, changes from an unconditional "would file" print + implicit `exit 0` to: compute the target directory name the same way the real branch does, then search `intent/` for ANY existing directory matching `*-band-<slug>` (not only today's date, so a breach spanning a date boundary before it's triaged does not silently re-refuse under a "new" slug or spuriously pass). If none exists, print the same message and set a non-zero process exit code at the end of the run; if one exists (filed by a person or by a real `pnpm watch-bands` run), the tier is treated as satisfied. `ci-local.mjs`'s existing `run("bands (dry run)", "pnpm", ["watch-bands", "--dry-run"])` call is unchanged — it already treats a non-zero exit as CI-PARITY RED and triages it, which is the desired behavior with no new plumbing.

**5. Spec-or-declaration.**
`intent/TEMPLATE.md` gains an optional field, e.g. `No-design-pass: <one-line reason>`, structurally identical to the existing `Rejected: <why>` pattern. `scripts/check-intent-chain.mjs`'s current `notes.push(...)` branch for `status === "accepted" && !existsSync(spec.md)` becomes `fail(...)` unless that field is present with non-empty content. This is a narrower, sibling rule to declared-limit C1 (which is about `plan.md`, not `spec.md`) — the two coexist without conflict, and a one-line fix needing neither an intent nor a spec is untouched, since it never enters `intent/` at all.

**6–9. Fix-proof.**
New `scripts/check-fix-proof.mjs`, exporting a function consumed by `scripts/ci-commits.mjs` (not a standalone `ci:local` step — the constraint pins it to the commit gate's existing per-commit worktree). For each commit `ci-commits.mjs` walks that is not already `fast`-stamped:
- Parse the Conventional Commits type from the subject; skip anything not `fix:`/`fix(scope):`.
- Skip if the commit predates `FIX_PROOF_SINCE` (a sha constant set to the commit that lands this check), verified with `merge-base --is-ancestor` — this is the going-forward boundary, declared in code rather than inferred.
- `git show --name-only` to classify touched files under `PRODUCT_PATHS` into test (`*.test.ts`) and source (everything else).
- **Both touched**: in the already-checked-out worktree, temporarily restore the source file(s) to their pre-commit (parent) content while keeping the test file(s) at the commit's content, run only the affected test file(s), require non-zero exit (RED); then restore the worktree to the commit's actual checkout and re-run the same test file(s), require zero exit (GREEN). If the source file and the test file resolve to different workspace packages (path prefix `packages/<a>` vs `packages/<b>`/`apps/<b>`), run `pnpm -F <package-of-source> build` before each test run, since tests import siblings through `dist`.
- **Source touched, no test touched**: require a `No-regression-test: <reason>` trailer in the commit message; fail otherwise.
- On failure, this is reported and the worktree is kept for diagnosis exactly as `ci-commits.mjs` already does for a FAST-check failure, extended to name the fix-proof step.

**10–13. Drills.**
`evals/run.mjs`:
- At case-load time (already the place `neutralize`-matches-`subject` is validated), add a repo-wide search — `git grep -F -- "<needle>"` over tracked files — for each `neutralize` string; any hit in a file not listed in the case's `subject` AND not present in a new per-case `leakOk` glob array (default empty; a case declaring one is stating, in the same one-line-declaration spirit as everything else in this intent, "this file legitimately echoes this wording") fails the load.
- `--drill-all` iterates every case's existing `drill()` path, aggregating results, and exits non-zero if any case fails to go RED — no new mechanism beyond looping the existing single-case drill.
- Every drill run (single or `--drill-all`) appends one line to a new local ledger, e.g. `.git/everdict-drill-log.jsonl` (`{at, id, pass}`), following the exact shape of `everdict-gate-log.jsonl`/the review-reports series so `watch.mjs`'s `SERIES` map can add a `drill-log` reader later without a new convention.
- A PASSING drill additionally updates a committed file, e.g. `evals/DRILLS.md` (sibling to `evals/README.md`/`RETIRED.md`, deliberately outside `docs/**` so it is not subject to the `kind:`/`status:` document-kind contract), recording per-case: id, date, git sha, and a digest of the subject files at drill time — the "certificate the next audit reads."

**14–16. Declared positions.**
`docs/architecture/harness-declared-limits.md` gains a new "Chosen limits" entry (alongside existing C1) for each of: 3σ-stays-dry-run-in-the-gate, GitHub-Actions-declared-off, fix-proof-going-forward-only — each with the four-part shape the page already requires (clause, why declined, what its absence does not mean, falsifier). §4's row 6 language is corrected once the fix-proof mechanism exists and has been driven against it. `.claude/rules/ci.md`'s closing bullet is qualified to say the local gate is the pipeline while remote CI stays off, rather than unconditionally instructing a `gh run watch`.

**17. Session-started collector.**
A new `SessionStart` hook entry in `.claude/settings.json` running a small script (e.g. `scripts/hooks/session-telemetry.mjs`) that attempts a short-timeout TCP connect to `127.0.0.1:4318`; if nothing answers, it spawns `pnpm telemetry` detached and unreferenced so it outlives the hook process, and exits 0 either way — a session must never fail to start because telemetry could not be reached.

## Areas of concern

- **The "smaller, same shape" bullets in the Problem section are not restated in Proposed outcome.** Scan findings with no validation result, the skills index naming no enforcing partner, the eval suite calling an alias a pin, `close-what-can-be-closed` shipped and still `accepted`, and play 16 being unlabeled N/A are all named as evidence but never committed to as deliverables. I have treated all five as **out of scope for this spec** — each looks like an independent one-line-to-small fix in the `intent/README.md` sense, and bundling five unrelated small fixes into one change directory conflicts with `intent/README.md`'s "one directory per change." The plan stage should confirm with the maintainer whether any ride along here or split into their own intents (the `close-what-can-be-closed` status fix in particular looks like a same-day one-line correction that needs no intent of its own).
- **3σ-refuses-until-filed can only be escaped by retuning the band or filing the intent — which is the existing, already-documented escape hatch** (`watch-bands`'s own generated intent text: "Either the cause is found and fixed, or the band is wrong and is retuned... with the reason"). I relied on this rather than inventing a new bypass, per the "no new bypass" constraint, but it means a maintainer under time pressure can retune a real band away just as easily as a false one — the same tension the page's own C1 entry already accepts for `plan.md`. Worth naming explicitly rather than discovering it during the first real 3σ breach.
- **The cross-metric duplicate-intent search (requirement 4) is a new obligation `watch.mjs` does not currently have** — today's dedupe check only looks at `${today}-band-${slug}`. Search must match on the metric slug across all dates, but must not falsely match an unrelated intent that happens to share a slug fragment; the directory-name convention (`<date>-band-<slug>`) makes an exact-prefix match after `-band-` safe, but this needs to be gotten right or the refusal either never lifts (a stale but still-open intent from months ago blocks every future breach of that metric) or never engages (a too-loose match treats an unrelated intent as covering the breach).
- **Fix-proof's per-file revert-and-rerun inside `ci-commits.mjs`'s shared worktree is the riskiest new mechanism here.** It must leave the worktree byte-for-byte at the commit's real checkout before the existing FAST checks (lint/typecheck/test) run against it, or a failed restore silently changes what those checks see for the *next* commit in the loop — the same class of defect this repo has already paid for once in `mutation-leak`'s "a killed run leaves its in-flight mutation in the tree." The plan should specify the restore as unconditional (its own `finally`, independent of ci-commits.mjs's outer one) rather than relying on the next `git checkout --detach` to fully clean it, since a partial hunk-level revert is not guaranteed to be undone by checking out a different commit if intermediate build artifacts (`dist`) were touched.
- **The lesson-leak check (requirement 13) needs either an allowlist mechanism or acceptance that `evals/README.md`/`lessons/*.md` will routinely trip it**, since those files exist specifically to describe what a case's lesson is and will often quote it. I designed a per-case `leakOk` declaration as the escape hatch, consistent with this repo's established pattern (`pnpm scan --dismiss --reason`, `guarded-doubles`' `OPEN` entries) — but this is a guess where the intent gives no explicit shape, flagged per the design-pass brief's instruction to say so.
- **The declaration field names I've proposed (`No-design-pass:`, `No-regression-test:`) are my own choices**, chosen only for consistency with the existing `Rejected: <why>` convention; the intent does not name them, and the plan stage should treat the exact field name as open, not settled by this spec.
- **Auto-starting a detached background process from a `SessionStart` hook has no defined lifecycle** — nothing here reaps it, restarts it if it dies, or bounds how many accumulate across many worktree sessions sharing one machine, beyond the idempotent port check. That is probably fine given the measured cost (157 bytes of stderr with nothing listening) but is a gap the intent doesn't address and the plan should either accept explicitly or bound.

## Open questions carried forward

- **Should the 2σ tier also refuse in dry-run?** Carried as stated in the intent: a 2σ diagnosis is a read-only model call that records nothing, so refusing until it runs would only buy a printed paragraph — not addressed by this spec, and I found nothing in the affected files that changes that reasoning.
- **Does the fix proof need to rebuild a sibling package's `dist` before running a cross-package test?** Answered in the intent and carried into this spec's Design (§6–9): yes, when the reverted source and the test live in different packages, because tests import siblings through `dist`.
- **New, raised by this pass**: does the cross-metric duplicate-intent search for requirement 4 belong in `watch.mjs` itself, or in a shared helper `check-intent-chain.mjs` also uses (since both now need "does an intent already exist for X" logic)? Not decided here — flagged above as an area of concern, restated here as a question the plan should settle rather than let two scripts grow divergent matching logic.

## Concerns, settled

Settled by the maintainer before the plan was written, in the order the pass raised them.

- **The five "smaller, same shape" items are IN scope.** The maintainer's instruction was every finding; each
  is small, and they share the audit as their why. `close-what-can-be-closed` was flipped to `shipped` in
  the commit that introduced this intent.
- **The 3σ refusal's only escape is the one the filed intent offers** — fix the cause, or retune the band
  with the reason committed. Accepted, and written onto the declared-limits page as C4 so the tension is
  arguable rather than discovered during the first real breach.
- **Cross-date dedupe: built.** `watch.mjs` asks for an OPEN intent (`Status:` not shipped/rejected) named
  `<any date>-band-<slug>`, exact suffix match, newest first — in both the dry run and the filing path, from
  one function, so the two cannot diverge. It does not belong in `intent-chain`: the chain checks shape and
  descent, and knows nothing about metrics.
- **The fix proof restores in its own `finally`** (`scripts/fix-proof.mjs` `proveInWorktree`), independent of
  `ci-commits.mjs`'s outer one, and rebuilds any sibling package it rebuilt at the pre-fix source. The green
  half is the FAST `pnpm test` the commit gate already ran on the same checkout before the proof.
- **No `leakOk` allowlist.** A file that carries the lesson and stays readable after the drill removes it
  elsewhere makes the drill vacuous whether or not it is allowlisted; allowlisting would be a design
  admission with nothing behind it. The two honest states are: the file is a `subject` (the drill removes
  the lesson there too), or the wording is changed. The fingerprint is the whole `neutralize` set, so a
  single shared word ("unsafe" in a rule about casts) does not trip it. Eleven cases leaked, not one.
- **Field names settled:** `Design: none — <why>` and `Regression-test: none — <why>`, matching the
  `Eval case: none — <why>` form `lessons/` adopted the day before, rather than new `No-…:` keys.
- **The probe, not a pure predicate.** The hook's `--probe` drives the REAL fact-gathering path against a
  real linked worktree and prints what it found; it runs `decideGate` (pure) and skips the ledger write and
  the permission verdict. A separate predicate would have proved the predicate and not the wiring, which is
  the distinction the guardrails check exists for.
- **The drill ledger is `evals/history.jsonl`**, committed, not a `.git/` file plus a separate certificate:
  one record, and it travels. Each drill line carries a digest of the subject bytes it certified, and
  `--drill-status` reports never / green / drifted / red per case without replaying anything. The full
  suite refuses to STAMP over a case with no red drill on record.
- **The going-forward boundary is read from git** (the commit that introduced the check), not a constant a
  reviewer has to keep in step with history.
- **The detached collector's lifecycle is accepted, not bounded:** one per machine, bound to a port, refused
  when the port is busy, dies with the machine. Written into the observability page.
