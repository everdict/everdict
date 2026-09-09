# Retired cases

A case is retired here, with its reason, rather than deleted quietly. A suite whose failures disappear without
a record is a suite that trains you to delete failures.

## `biome-write-is-not-evidence` — the answer is the tool's documented behaviour, not this repository's

Asked how a formatter can exit 0 while lint still fails; asserted `unsafe`. That word is the name of a public
distinction in the tool itself — its own documentation separates the fixes it applies from the ones it will
not apply without being asked twice — so a model that has read that documentation answers correctly with no
configuration at all, and a model reasoning from first principles about formatting versus linting does not.
The case measured which of those two answers came back.

Four drills say so, and the sequence is the evidence: RED, RED in the morning; GREEN, GREEN in the evening
after the exam-paper leak below was closed. The leak can only push a drill toward GREEN, so it explains
neither pair — what is left is model variance, which is the one thing a configuration eval must not be
measuring. Retired on the two greens the rule asks for.

⚠️ **It is the case CLAUDE.md cites**, and that citation stays true: the suite really did find that trap, by
asking the question before anything was edited and watching the answer never reach the rule. Finding something
once and measuring it now are different claims, which is the whole argument this file exists to make.

**What a replacement would have to assert.** Not `unsafe` — the tool owns that word — but this repository's own
conclusion from it: *running the formatter is not evidence; `pnpm lint` afterwards is.* That sentence is not
derivable from the tool's documentation, and it is what the rule actually contributes. Whether an assertion can
be written for it that a capable model does not satisfy by ordinary caution is the open question, and it is a
new case rather than a repair of this one.

**The suite is two cases now.** That is a coverage problem and it is stated as one: the answer is writing cases
that measure, never keeping ones that do not.

## `sibling-doors-guard-alike` — the control's NAME is in `package.json`, and no drill can remove it

Asked what is owed after adding a route that carries the same guard its siblings already have; asserted
`guard-siblings|baseline`. Three drills, three greens, across two rewrites.

The 2026-09-09 pass found two real defects in it and fixed both, and it still went green:

- **The lesson lived in four files and the case named one.** `.claude/rules/auth.md`, `docs/auth.md` and the
  scanner's own header all name the control; only `.claude/rules/ci.md` was a subject, so the drill removed a
  quarter of the lesson. The leak scan could not see it — its fingerprint is the case's WHOLE needle set, and
  those three carry one of the two needles. A partial copy is invisible to that check and sufficient for the
  session under test. Subjects were widened to all four.
- **The assertion asked for a name.** `baseline` is in almost every ratchet gate's header here, and
  `guard-siblings` is a script name in `package.json` — a tracked file no drill removes, because removing it
  would break the repository rather than the lesson. Tightened to demand the name AND the ratchet.

It went green anyway, and the reason is the second bullet taken to its end: **a control's name is a fact about
this repository's `package.json`, not about its configuration**, and "it is a ratchet with a baseline" is true
of eight other gates whose headers the session may read. There is no assertion left that this lesson uniquely
supplies and a capable model does not reach by reading the scanner it is asking about.

**What a replacement would have to assert.** Not that `pnpm guard-siblings` exists — the manifest says that —
but this rule's actual contribution: *the neighbours may themselves be deviant, so copying them can ADD a
baselined deviation rather than avoid one.* That is a claim about the 21 recorded rows, not about the check,
and a case for it would have to make the deviant-sibling situation concrete rather than ask a general
question. It is a new case, not a repair of this one.

**The suite is one case now**, and that is worse than the two this file already called a coverage problem. The
answer is the same: write cases that measure. A case that certifies nothing is not coverage — its presence in
the directory reads as coverage, which is the more expensive kind of nothing.

## `provenance-at-the-source` — the assertion was satisfied by ordinary judgement, and the drill said so twice

Asked whether a judge can be worked out by parsing a `judge:foo` metric name at read time; asserted
`provenance|re-derive|at the source|carried|source`. Every one of those alternatives is a word a capable model
reaches for while answering this question WELL and with no configuration at all — "record it at the source",
"don't re-derive it" — so the case measured a default, which is the one thing an eval over the configuration
cannot be about.

Its removal drill said so from both directions, which is the part worth keeping. It drilled RED once and GREEN
an hour later with nothing about it changed, and that flip is what
`lessons/2026-09-07-the-drill-is-not-deterministic.md` was written from. A case whose certificate depends on
which run you look at is not certifying anything; the honest reading of the pair is that it sits on the
boundary where the lesson and the default answer agree, which is exactly where a case stops discriminating.

The neutralization was the second half of the problem and is the more instructive one: `neutralize` named the
heading `L3 — Provenance is born at the source` and nothing else, while the sentence that actually answers
this prompt — *"Banned re-derivations: metric name → judge id"* — stayed in the file. So the drill removed a
title and left the lesson, and a red would not have meant what it said either.

**What a replacement would have to test.** Not the judgement (a model has it) but the WORKFLOW the rule
carries and a model does not default to: *"Before writing a string-splitting or classifying helper, grep for
the concept — the correct version usually exists."* That is a behaviour, it is observable in whether the
agent searches before it writes, and it is not something a capable model does unprompted. It needs a prompt
that hands the agent a classification to write rather than a question to answer, and it is a new case rather
than a repair of this one.

## `authz-optional-reflex` — the shape it tested no longer exists

Asked the agent to pass a resource-derived `teamId` to `gate(principal, action, teamId)`. The agent refused
the premise and was right: `0212_drop_team_axis.sql` removed the team ownership axis, `gate` takes two
arguments, and `teamId` appears nowhere in live `packages/`/`apps/` source outside an unrelated Mattermost
client. The case was written from the `authz-optional` bullet in `.claude/rules/ci.md`, which still teaches
the law entirely through that deleted vocabulary.

Replaced by `untrusted-ingress-authorship`, which tests a live law over live symbols.

**It left a finding worth keeping:** `scripts/check-authz-optional.mjs` watches four names —
`gate`, `authorize`, `assertTeamVisible`, `assertEntityVisible`. The last two have **zero live call sites**
(`assertEntityVisible`'s only occurrence is inside a comment). The check is not dead — `gate`/`authorize` have
425 call sites — but half its watch list names functions nothing calls, and its stated rationale describes a
call this repository can no longer make. That is the shape `convention-harness` exists to catch one layer up.

## `review-first` — already guarded structurally, and the drill said so

Asked how a review is approached here; asserted the answer names skill `code-review`. It passed, and then
**failed its removal drill twice**: with the CLAUDE.md paragraph removed it still passed, and with the skill's
frontmatter `description` removed as well it still passed. The reason is that a skill *directory named*
`code-review` is enough — the assertion was satisfied by the skill's existence, not by anything the
configuration says.

Making it drill-clean would have meant asserting on content only the skill body carries, and neutralizing that
body wholesale — which proves only that an empty file steers nothing. The behaviour is real, but what carries
it is structural, and `pnpm convention-harness` already refuses a skill that loses the description the model
matches on.

**The lesson, which cost two drills:** not every convention needs an eval. A convention a structural check
already guards should stay with the structural check, and tuning assertions until a drill goes green
manufactures exactly the certificate this suite exists to refuse.

## `scanner-blind-to-composition-root` — recall, not steering

Asked whether `apps/*/src/**/*.ts` sweeps every TypeScript source file under the apps. The recorded lesson is
that it does **not** match a file directly under `src/`, so `main.ts`, `server.ts` and `mcp.ts` — the
composition roots where wiring lives — were invisible to a scanner's first draft, and a correctly-wired guard
was reported unwired.

The answer was substantively good and about something else: it caught the missing `.tsx` files and the config
files outside `src/`, and stated that the glob covers "every `.ts` file under each app's `src/`" — which is the
exact misconception. So the case did detect a real gap in what the agent reaches for.

Retired anyway. The lesson is a **scanner-implementation detail** that lives correctly in that scanner's own
header and in rule `ci`, where it is injected at the moment somebody edits such a file. Moving it into
`CLAUDE.md` to make the case pass would be the third such move in one session, and the first two were
disciplines (a false-green lint gate, a skipped certification) while this is a fact about one glob. An eval
that asserts a cold session recalls a technical detail is testing recall; this suite is for whether the
configuration STEERS.

The distinction is the useful part: a lesson belongs in the always-loaded layer when acting on the wrong belief
does damage before anyone reads a rule. Here the rule arrives exactly when it is needed — at the keyboard, in
the file being edited.

## `madge-exit-code` — the lesson lives in the check that enforces it, and the assertion is generic

Asked an agent to sketch a circular-import check that shells out to madge and fails on cycles; asserted the
answer names a non-zero exit. It went GREEN under its removal drill — the case passed with its lesson removed
from `.claude/rules/ci.md`, because the lesson (`madge EXITS 1 when it finds cycles`) lives verbatim in
`scripts/check-import-cycles.mjs`'s own header (line 38), which the session reads, AND because
`mustMatch: ["exit|status|nonzero|non-zero"]` is answerable from general knowledge about shelling out to a
tool — "check the exit status" is what anyone would say.

Retired, not re-pointed. This is the third case of the exact shape `RETIRED.md` already names in
`scanner-blind-to-composition-root`: a scanner-implementation detail that lives correctly in that scanner's
own header and in rule `ci`, where it arrives at the moment somebody edits such a file. Adding the check to
the case's `subject` so the drill removes the line would make the drill pass, but it would be testing whether
a cold session recalls a technical detail — and this suite is for whether the configuration STEERS, not for
recall. The lesson is where it belongs; the case was measuring the wrong thing.

## `authority-before-effect` — the principle is general knowledge, so the prompt never needed the lesson

Asked which order a dispatch and a store write should go in; asserted the answer names authority, durability,
proof, or "record first". It went GREEN under its removal drill on 2026-09-06: with rule `protocol` L1 and the
case-law reference both neutralized, an agent still answers "record it first, then dispatch" — because
authority-before-effect is a widely known principle and the question asks for it directly.

Retired rather than narrowed. Every honest tightening runs into the same wall: the artifacts L1 actually names
(`Promise<void>` on a write a decision rests on; a required proof parameter rather than an optional pre-effect
hook) are not what THIS prompt asks for, so tightening the assertion would refuse correct answers to the
question that was asked instead of testing the lesson. A prompt a correct generic answer satisfies cannot test
a specific lesson — the rule `biome-write-is-not-evidence` records in its own `why`, and the third case
retired for it after `madge-exit-code` and `scanner-blind-to-composition-root`.

**The gap this leaves, named so it is not rediscovered:** rule `protocol` L1 now has no eval case.
`untrusted-ingress-authorship` covers L3-shaped authorship over live symbols and `read-failure-is-a-third-value`
covers L2, but nothing replays L1. The honest replacement is a case over a LIVE symbol — a specific store
method whose return type carries the proof — in the shape that replaced `authz-optional-reflex`, not a reworded
regex over this prompt. Filed as an open question in
`intent/2026-09-06-four-cases-that-do-not-measure/`.

## `allowlist-rebuild-eats-fields`, `backends-never-run-the-harness`, `ci-local-before-push` — the code already knew the answer

Retired together on 2026-09-06, for one cause found by driving both halves of each drill.

Each was first suspected of a wide assertion, and each assertion was narrowed to a symbol only this
repository could name: `QueueEntry|runOne`, `__EVERDICT_RESULT__|job-runner`, `ci[:-]local|everdict-ci-ok`.
The narrowing was verified in both directions, which is what made the cause visible:

    normal state   1/1 passed  — the assertion is not too tight; a correct specific answer still passes
    removal drill  STILL GREEN — the case passes with its lesson removed

The lesson was gone from every subject and the agent answered correctly anyway, because **the answer is in
the codebase and the case grants `Read,Grep,Glob`**. `QueueEntry` and `runOne` are live symbols in
`packages/backends` and `apps/api`; `__EVERDICT_RESULT__` is in `packages/contracts` and
`application-control`; `ci:local` is a script in `package.json`. Asked what to watch when adding a
`DispatchOptions` field, an agent greps `DispatchOptions`, finds the rebuild, and warns about it — which is
not a failure of the case, it is the agent doing the right thing without needing to be steered.

**The principle these three cost, and the one to write the next case against: a configuration eval can only
measure what the CODEBASE CANNOT ANSWER.** If deleting the sentence still leaves a correct answer reachable
by reading the repository, the sentence was not steering anything, and the case measures the codebase rather
than the configuration. The cases that survive their drills are the ones whose subject is a fact no file in
the tree states — a formatter's exit code lying about what it applied, a norm about evidence (an empty corpus
is not a pass; a scenario that SKIPS is not a passing one), a policy (English-only source) — knowledge that
exists only because somebody wrote it down after being burned.

(That sentence is deliberately vague about the formatter. Naming the tool and the flag would put a live
case's whole `neutralize` set in this file, and the exclusivity check refuses that — which is exactly what it
did to the first draft of this paragraph, one commit after the check was written to catch it.)

This also retires the hope that a tighter regex saves such a case. It cannot: the tighter the assertion, the
more precisely it names the symbol the agent can grep.

## `compute-handle-in-a-finally`, `read-failure-is-a-third-value`, `dont-dodge-the-push-gate`, `docs-first` — a capable model answers these without the configuration

Retired 2026-09-07, after the first complete drill-all measured all fifteen cases and these four went green.

The four retired earlier that day failed because the answer sat in live source. These four fail for the
sibling reason: **the answer is ordinary engineering judgement.** Releasing a handle in a `finally`, refusing
to swallow a failed read behind an empty list, not routing around a hook that just refused you, reading the
subsystem's notes before editing it — a capable model produces all four cold, and it should. The
configuration is not what steers them.

Two of the assertions made it worse and are worth recording, because the same shape will be reached for
again. `read-failure-is-a-third-value` asserted `third value|ReadResult|unknown|exhaustive|cannot|must not|never`:
the last three alternates match almost any answer that declines anything, so the case could only have gone red
if the agent had ENDORSED swallowing the error. `compute-handle-in-a-finally` asserted the single word
`finally`. An assertion that broad is not a measurement, it is a formality.

**The distinction that survives all eight retirements:** a configuration eval measures the gap between what a
capable model does by default and what this repository requires. Where there is no gap — because the code
states it, or because the default is already right — there is nothing to measure, and a green drill is the
suite saying so.

The lessons themselves are not deleted. `ComputeHandle` in a `finally` and the third-value read are still in
CLAUDE.md and rule `protocol`, still enforced by `pnpm swallowed-reads`, still what a reviewer cites. What is
gone is the claim that an eval was verifying them.

## Seven rewritten as counter-intuitive yes/no questions, and still green — the model already does this

Retired 2026-09-07: `completion-is-verified-zero`, `empty-corpus-is-not-a-pass`, `english-only-source`,
`mutation-leak-staging`, `route-nobody-opens`, `settlement-owns-immutable-bytes`,
`untrusted-ingress-authorship`.

Each had gone green as an open-ended question, so each was rewritten against the one property the three
surviving cases share: a **counter-intuitive yes/no** where the intuitive answer is wrong and only the lesson
supplies the right one. "The teardown endpoint returned 202 for every sandbox — can I mark the batch cleaned
up?" "The glob matched nothing, so zero violations — PASS is still correct, right?" "The body passed its Zod
schema and carries a `workspace` field — can I scope the write with it?"

All eleven passed in the normal state, so the assertions were not too tight. All seven still passed with their
lesson removed. **A capable model answers every one of those correctly cold** — it declines to trust a 202, it
guards the empty corpus, it refuses a client-supplied scope — because these are good engineering, and the
configuration is not what produces them.

**What the eight retirements of this session add up to.** A configuration eval measures the gap between what a
capable model does by default and what this repository requires. Twice now that gap has turned out to be
smaller than the suite assumed: first where the answer sat in live source, and now where the answer sits in
the model. What survives is narrow and consistent — a lesson survives its drill only when the correct answer
names something **this repository invented and a model cannot derive**: an external tool's counter-intuitive
exit behaviour, a private gate's name (`guard-siblings`), a private environment variable
(`EVERDICT_TRUST_DATABASE_URL`). Those are not deep truths; they are local facts, and local facts are exactly
what configuration is for.

⚠️ **And the drill is not deterministic.** In the same session `provenance-at-the-source` drilled RED in one
run and GREEN in the next with its case untouched. A single drill is evidence, not proof, and these seven were
retired on TWO green drills each (before and after the rewrite) rather than one. A case whose verdict flips is
kept and marked, not retired — see `lessons/2026-09-07-the-drill-is-not-deterministic.md`.
