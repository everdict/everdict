---
paths: "**/*"
---
# CI parity rules (push) — never push red

See skill `ci`.

- **NEVER `git push` before the full GitHub Actions CI passes locally.** Run `pnpm ci:local`
  (`scripts/ci-local.mjs`) — it mirrors `.github/workflows/ci.yml` step-for-step and, on a clean
  green tree, stamps `.git/everdict-ci-ok` with the HEAD sha.
- **Enforced, not advisory**: a PreToolUse hook (`scripts/hooks/pre-push-gate.mjs`, wired in
  `.claude/settings.json`) denies `git push` unless every commit the push carries is stamped and HEAD's stamp
  is `full`. Committing after the gate invalidates that commit's stamp — re-run `pnpm ci:local` (turbo cache
  makes it fast). Never work around the hook (no stamp forging, no pushing from outside the tool).
- **EVERY COMMIT IN A PUSH, NOT ONLY ITS TIP.** `pnpm ci:local` validates HEAD, and GitHub also only runs its
  checks on the tip — so a batch of eight commits used to ship seven that had never been built, while the split
  history advertised a bisectability it did not have and nothing downstream contradicted it. `.git/everdict-ci-ok`
  is a LEDGER now (`<sha> full|fast`), and **`pnpm ci:commits`** walks what is ahead of the remote and runs
  lint+typecheck+test on each in a throwaway worktree. Fast, not full, on purpose: gitleaks-over-all-history,
  the web build and the mutation suite answer questions about the tree being PUBLISHED, while a broken build or
  a failing test is what a bisect actually lands on. The two levels are recorded separately because stamping
  them alike would put the same lie one level down. So: `pnpm ci:commits` then `pnpm ci:local`, then push.
- The 5 essential commands are NOT the whole gate. CI additionally runs: `pnpm cone`,
  `pnpm web-imports`, `pnpm artifact-frame`, **`pnpm convention-harness`**, **`pnpm docs-check`**,
  **`pnpm constructed-casts`**, **`pnpm guarded-doubles`**, **`pnpm unwired-capabilities`**, **`pnpm option-forwarding`**,
  **`pnpm language-policy`**, **`pnpm guard-siblings`**, **`pnpm source-bytes`**, **`pnpm untrusted-ingress`**, **`pnpm gated-doors`**, **`pnpm mutation-leak`**,
  `node scripts/live/empty-env-boot.mjs`, the self-contained web job (contracts build +
  `pnpm -F @everdict/web lint`/`build`), and a full-history gitleaks scan.
- **`pnpm convention-harness` keeps the conventions reachable**: every `.claude/rules/*.md` declares a
  `paths:` glob and that glob still matches live code, every referenced rule exists, every skill keeps the
  `description` the model matches on. A rule pointed at moved code is not a weak rule but an ABSENT one, and
  it fails silently — two were found dead this way (`suite.md`, `workspace-integrations.md`), both holding
  invariants a later review then found broken. Moving or renaming a package re-points its rule in the SAME
  change.
- **`pnpm docs-check` keeps the cited ADDRESSES real** — in `docs/**` and, since arch-review 56, in
  `.claude/rules/**` + `.claude/skills/**` too, from the one predicate rather than a second copy. The push
  layer is injected into context by a glob, so a rule citing a moved file teaches the wrong address at the
  moment of editing and nobody is reading it deliberately enough to notice: widening the existing check found
  29 dead paths across 7 skills on its first run. `docs/architecture/rearchitecture/**` is exempt on purpose
  (historical review records), and a path that is absent BY DESIGN goes in `KNOWN_ABSENT` with its reason.
  It also checks the SYMBOLS `.claude/**` names, because the rot that actually happens here is a file that
  stayed while the interface inside it was deleted — a backtick is a claim that this repo declares the name.
  Live means non-test `packages/`+`apps/`: tests are excluded because a ratchet keeps naming what it forbids,
  and `scripts/` because this check's own prose named its example and that alone made it pass. A name that is
  gone may still be WRITTEN — without backticks, as the deletion bullet in rule `backends` does.
- **`pnpm language-policy` keeps the repo English** (CLAUDE.md's language policy), as a RATCHET: the 550
  files that already carry Korean are recorded in `scripts/language-policy-baseline.txt` and pass, a file NOT
  in that list may not introduce it, and a baselined file that has been cleaned must leave the list in the
  same change. A bulk translation would be the wrong repair — those comments carry the REASON a piece of code
  is what it is, and precision is exactly what a sweep trades away. The debt is repaid where someone is
  already reading the file.
- **`pnpm guarded-doubles` is the always-succeeds-double law, enforced instead of stated** (arch-review 64).
  A conditional write exists to refuse; a hand-written double whose only outcome is the success value turns a
  guard that rejects every real call into a green test. The prose law was written and broken in the same wave,
  which is what moved it here. Every allowlist entry names whether the granted call is the test's PREMISE or
  an `OPEN` defect, and an entry whose site stopped hard-coding a success FAILS — a reason that outlived its
  subject reads as permission, and an unremoved `OPEN` reads as a defect still open when it was fixed.
- **`pnpm unwired-capabilities` is the optional-dependency law, enforced instead of stated** (arch-review 67).
  An optional port whose only implementations are classes nobody constructs in `apps/*/src` is a capability
  the tests exercise and production does not have — `deps.x?.y()` reads the same either way, which is why the
  prose version failed: it was written after arch-review 64 and broken by its own author two waves later,
  leaving every production private-verifier case recording no cleanup debt. Ports satisfied STRUCTURALLY (an
  object literal at the root) are deliberately not flagged — the compiler already refuses a missing one where
  it is passed. `DECLARED_UNWIRED` states why a capability is inert on purpose.
- **`pnpm unwired-guards` is the other half of `unwired-capabilities`** (arch-review 124). That one asks
  whether an optional PORT has an implementation; this asks whether a pure GUARD — `assert*` / `refuse*` /
  `require*` / `reject*` — is CALLED. They fail the same way and neither sees the other's shape. One review
  found three at once: `refuseUnsafeCallback`/`assertPublicTarget`, the outbound SSRF decision, exported from
  application-control's index and imported by nobody while three other lanes dialled a caller-named URL
  unchecked; `assertRoleProfile`, the ownership protocol's O2 invariant, cited by `assertIndependentVerification`
  as the "necessary" half and called by nothing; and `requireOwed`, a third spelling of a rule already decided
  at boot and by a throw. The three repairs are the three legal answers the check asks for — WIRE it, DELETE it
  (saying where the rule is enforced instead), or DECLARE it with the door that will open it.
  ⚠️ Its first draft's sweep used `git ls-files 'apps/*/src/**/*.ts'`, which does not match a file directly
  under `src/` — so `main.ts`, `server.ts` and `mcp.ts`, the composition roots where wiring LIVES, were
  invisible and a correctly-wired guard was reported unwired. The check walks whole-tree pathspecs and
  `.tsx` for that reason; a scanner that cannot see the composition root generates false findings, which is
  worse than none.
- **`pnpm authz-optional` is the "an authorization input may not be a maybe" law, enforced instead of stated**
  (arch-review 79). In an authz call `undefined` is the PERMISSIVE arm — no team constraint, so the
  workspace-level action decides alone — and optional chaining produces `undefined` for reasons that have
  nothing to do with the resource: a service this deployment did not wire, a row that is not there. The prose
  version failed THREE TIMES IN TWO HOURS, all by its author: `deps.campaignService?.get(...)` inside the
  security fix that added the team gate, then `deps.issueService?.get(...)` in the fix for that (both
  transports), then `issue?.teamId` handed straight to `gate` in the fix for THAT. The mechanism is not
  forgetfulness: the dep's type is `issueService?: IssueService`, so a plain `.get` does not compile, and the
  shortest path from that compile error is `?.` rather than a refusal — the optional type makes the unsafe
  spelling the one that builds. Two fixes are allowed at a flagged site and no third: refuse when the
  capability is absent, or narrow the value first and pass it plainly.
- **`pnpm import-cycles` is a RATCHET over circular imports** (arch-review 84). ESM tolerates a cycle only
  while every use is deferred to call time; one module-scope use — a `const` derived at import, a decorator,
  a registry populated on load — and one side sees a half-initialized namespace, which surfaces as a runtime
  `undefined` in a module that type-checks. The symmetric completion join produced one the moment its shared
  predicate and fact were put inside one of the two writers. Sixteen cycles predate the check and are
  baselined (`scripts/import-cycles-baseline.txt`); a NEW one fails, and a baselined one that is GONE must
  leave the list in the same change. The fix is almost always the same shape: the value both sides need
  belongs to neither, so give it its own module that imports from neither.
  ⚠️ madge EXITS 1 when it finds cycles — that is its job — so the first draft's plain `execFileSync` threw
  on the only interesting case and the check would have passed exactly when there was something to report.
  Found by driving it against a tree that HAS cycles, not by reading it.
- **`pnpm option-forwarding` is the allowlist-forwarding law, enforced instead of stated** (arch-review 69).
  `DispatchOptions` travels through several decorating dispatchers and the Scheduler; most links pass the
  object whole, but a Scheduler entry WAITS, so its options are taken apart into `QueueEntry` and rebuilt at
  `runOne`. That rebuild is an allowlist, and it has now silently eaten two fields — `onActivate`
  (arch-review 58 W2) and `acknowledgeResult` (69), the second while the block carried TWO comments warning
  about the first, three lines above where it was dropped. The check reads the field names off the interface
  (never a second copy), treats whole-object forwarding as safe by construction, and asks only the rebuilders
  to name every field. ⚠️ Its first draft also flagged three HTTP proxy dispatchers, which use undici's
  unrelated `Dispatcher.DispatchOptions` — eighteen healthy lines, which is how a scanner teaches people to
  skip its output. Narrow before wiring: a check nobody reads is worse than none.
- **`pnpm protocol-mutations` is ON DEMAND, not a gate** (removed from `ci:local` and from CI on 2026-08-29,
  by the maintainer's decision — it cost ~90 minutes of real builds and real suites and dominated every
  iteration). Everything below still describes what it does and how it fails; what changed is WHEN it runs.
  Run it beside the change that adds or moves a rung — `--only <substring>` is seconds, `--shard i/n` splits
  a full pass — and treat a full run as a periodic audit rather than a push blocker. `pnpm mutation-leak`
  STAYS in the gate precisely because the script still exists: a manual run killed mid-rung leaves a
  neutralized production file in the tree, and no commit may carry one.
  It is the "does the suite actually catch this" check (arch-review 53, Wave F):
  it neutralizes one protocol at a time in a production file and requires the suite that claims to enforce it
  to go RED, reverting in a `finally`. It refuses to start on a dirty worktree for the files it mutates. A
  green suite proves the tests pass; this proves they would fail without the protocol — a distinction this
  repo has paid for twice (a scanner draft green over the defect it was written for, a judgment fixture that
  certified a gap). A new protocol adds its mutation there; a mutation whose target line is gone FAILS rather
  than silently testing nothing.
  It is SLOW on purpose — 236 rungs, each a real build and a real suite — but half of that was waste: every
  rung ran mutate → build → test → restore → **build**, and the restore-build was discarded by the next rung's
  own build. Rungs are grouped by build target now and the restore-build runs only at the boundary where the
  target changes: **226 package builds → 122**, ~15 minutes off the gate with nothing checked less. The
  boundary rebuild is not optional — a rung in another package may load this one's `dist`, and a stale one
  would run the previous rung's mutation against a suite that never asked for it. ⚠️ The deferral means a
  KILLED run can leave a clean tree over a mutated `dist`; `dist/` is gitignored so it cannot be committed
  (unlike the old failure mode), and the debt is recorded in `.git/everdict-mutation-stale-dist`, paid by
  SIGINT/SIGTERM handlers and, failing that, by the next run before it does anything else.
  ⚠️ **A RED TEST PROCESS IS NOT A RED ASSERTION** (arch-review 115). This runner's whole output is the claim
  "the suite went red BECAUSE the protocol was removed", and `vitest exit != 0` is the only evidence it has —
  so every other way a suite can go red is counted as enforcement. Three of them were live: a pre-test build
  that failed (nothing compiled, so of course it is red), a restore-build that failed while the marker was
  cleared anyway (the NEXT rung's suite loads the previous rung's mutated `dist`), and a `pnpm -F <renamed>
  build` that matches no package and **exits 0** (nothing is rebuilt and the silence reads as success). Builds
  are consumed now — `rebuildOrThrow` — a failure is a GATE failure rather than a mutation result, the marker
  survives it, and every rung's build target is checked against the real workspace at startup.
  ⚠️ **AND THE DEFERRED REBUILD IS OWED BY A PACKAGE, NOT BY AN ARRAY INDEX.** The first version of the
  build-count optimization decided the group boundary from the next DECLARED rung; a rung that skips for
  missing infrastructure, or whose target line is gone, returns from above the `try` and never settles the
  debt. Five rungs skip for missing infrastructure, and simulating the real ordering put every one of them directly
  after a deferred build — so the run that reported "231 checked, 0 holes" did so with a mutated dist standing
  at five boundaries. The debt is explicit state settled before the next rung that builds something else,
  runnable or not, and after the loop whatever the exit path.
  ⚠️ **IT DOES NOT FIT IN A STEP, AND FOR A LONG TIME IT WAS ONE** (arch-review 120). The gate is ~90
  minutes of real builds and real suites and it sat inside `core`, a job declared `timeout-minutes: 30` — so
  it could never have reached its own end, and the thirteen gates declared AFTER it (`docs-check`,
  `constructed-casts`, `guarded-doubles`, `unwired-capabilities`, `authz-optional`, `import-cycles`,
  `option-forwarding`, `language-policy`, `guard-siblings`, `source-bytes`, `mutation-leak`, the boot probe)
  could never have run at all. It was moved to its own four-shard job, and then out of CI ENTIRELY on
  2026-08-29 (see the head of this bullet): an hour of compute on every push is a cost the maintainer chose
  not to pay. `--shard <i>/<n>` survives for a manual full pass and still packs whole BUILD GROUPS
  longest-first, so a shard keeps the one-build-per-package-boundary optimization instead of re-compiling the
  same package; an empty shard is REFUSED rather than reported green. Neither `ci:local` nor `ci.yml`
  references it any more — if you re-add it, re-add it as a job, never as a step.
  ⚠️ Its options are now REFUSED when unrecognised. `--filter <name>` — a plausible spelling of `--only`, and
  not a flag this script has — was accepted in silence, so one rung became the full suite: ninety minutes,
  files mutated while the author was editing them, and an answer to a question nobody asked. Same shape as
  `biome check --write` exiting 0 over fixes it did not apply.
  ⚠️ **A MUTATED TREE THAT DOES NOT COMPILE IS TWO DIFFERENT ANSWERS, AND ONLY ONE OF THEM IS EVIDENCE**
  (arch-review 119). Once uncompilable rungs stopped being ignored, 29 of them surfaced at once — every one a
  rung whose suite had NEVER run, because the build failure used to be discarded and the suite then ran against
  the previous rung's `dist`. Reading each one's actual `tsc` error splits them cleanly, and the split is the
  decision:
  · **The type system refuses** — the neutralization defeats a narrowing (`.reason` on a `ReadResult`, `.state`
    on `never`), drops a `| undefined` guard (TS18048/TS2345), or makes a comparison provably empty. The
    consumer below stops compiling, which is enforcement STRONGER than a red suite. Declare
    `compilerEnforced: true` and say so in the rung.
  · **The compiler objects to the SHAPE of the mutation** — `noUnusedLocals` on a symbol the removed line was
    the last reader of (TS6133/TS6138), an implicit `any[]` from an untyped `= []`, or a `to:` naming a
    property the type never had. None of that is the protocol being protected: a refactorer removing the guard
    removes the import with it. **Rewrite the `to:` so it builds** — `void <symbol>;`, `(void <symbol>, expr)`,
    a typed empty (`xs.slice(0, 0)`) — so the SUITE is what refuses. 18 of the 29 were this.
  Declaring the second kind is the worse error of the two: it records a named certificate of enforcement for a
  protocol nothing ever tested.
  ⚠️ **NEVER `import()` THIS SCRIPT TO SEE IF IT PARSES.** It is a script, not a module: importing it RUNS it,
  in whatever tree you are standing in. `node -e "import('./scripts/trust/protocol-mutations.mjs')"` started a
  full mutation run in a shared worktree. `node --check <file>` is the syntax check — it never executes.
- **`pnpm guard-siblings` refuses a door whose neighbours guard something it does not** (arch-review 119).
  One wave found the same shape three times: `PUT /agents/:id` gained a team gate and `PUT /models/:id` kept a
  bare `models:write`; `create_judge` files a capability under a team and `create_rubric`/`create_model`/
  `create_runtime`/`create_agent` wrote with none; `get_dataset` refuses a private team's dataset and
  `diff_datasets` returned both versions of it. Reading for it works exactly once — the door written AFTER the
  lesson is the door that never learned — so the rule is mechanical: within one resource, an entity-naming
  door carries the guards its siblings carry. A RATCHET over a baseline (`--write` regenerates), because 21
  deviations exist today and each is a door somebody has to look at; what is refused is a NEW one, or a door
  losing a guard it had. A resource whose access model genuinely differs says so in `OTHER_MODEL` with the
  model it uses instead — `capability` has its own `visibility` field, and the tracker's records are filing
  and visibility only, which `docs/tracker.md` states by name.
- **`pnpm untrusted-ingress` is the AUTHORSHIP law, enforced instead of stated** (arch-review 122). A field the
  PLATFORM authors — an `artifact://` coordinate, a billing provenance, a verifier receipt, a judgment seal —
  riding on a document a PRODUCER submits, and then acted on. Three P0s in three reviews, all that shape:
  the `CaseResult` GC coordinate (66) let a runner name objects a settlement would delete; `outputRef` and
  `screenshotRef` (121) let one read and delete objects it does not own, and be handed a presigned URL for
  them; `provenance` (122) let one decide WHO PAYS and bill a workspace that never ran the case. Each was
  closed by splitting the schema — `TraceEventSchema` for what WE stored, `UntrustedTraceEventSchema` for
  what a producer sends — and each closing change had to hunt the doors by hand, which is why the door
  written AFTER the lesson is the one that never learned it. The check refuses a bare producer-document
  schema anywhere outside its declaration; every allowlist entry states why that site is not a door, and the
  honest reasons are "it decodes bytes WE wrote" and "it IS the declaration". An entry whose site stopped
  naming the schema FAILS — a reason that outlived its subject reads as permission for a door nobody opened.
- **`pnpm gated-doors` refuses a transport that locks itself on a dependency the composition root never
  passes.** A route saying `if (!deps.x) … 404` means "this deployment may not have x"; it says nothing about
  whether ANY deployment does. Two doors shipped dead for exactly that reason: every `/environments` door
  answered "not configured", so a world could not be registered through the API and therefore never
  referenced — while the resolution and the manifest seal behind it worked perfectly — and the dataset
  ATTEST door answered the same, so the only way to GRANT a ground-truth approval was unreachable while the
  submit-time refusal that requires one worked. `unwired-capabilities` cannot see this: it asks whether a
  composition root CONSTRUCTS the port, and both were constructed and handed to services — just not to
  `buildServer`. ⚠️ Its first draft matched the literal "not configured" and missed one of the two defects it
  was written for, because `registerEnvironmentRoutes` hoists that sentence into a `const`; the marker is the
  404 now, not the prose. Its second flagged four healthy doors whose names sit inside a conditional spread
  (`…? { a, b } : {}`, no trailing comma), so the match is any mention of the name in the
  comment-stripped call — erring toward missing a defect rather than inventing one.
- **`pnpm mutation-leak` refuses a COMMIT that carries a neutralized protocol** (arch-review 112). The warning
  below covers a killed run; it does not cover the run that is alive and WORKING while you stage beside it. The
  gate's dirty-tree guard protects the GATE, not the author — between two rungs the tree is clean, and while a
  rung is in flight it is dirty in a file you never opened. That is how `cdef2c2a` shipped
  `const state = "written" as const; void evaluateRef;` (the arch-review 70 P1 defect, put back) inside a commit
  about something else, costing a two-commit history rewrite. So: **stage by explicit file list, never `git add`
  a directory, while the mutation gate runs — and read back `git diff --cached --name-only` before committing.**
  The check compares every commit ahead of the remote against the `to:` text the rungs already declare, in two
  seconds, where `ci:commits` would find it slowly at push time. ⚠️ Its first draft joined the diff's added
  lines WITH their `+` prefixes, so a multi-line replacement could never match and it reported the real
  incident as clean — the distinctive fingerprints were exactly the ones it could not see. Found by driving it
  against that commit, which is the only way this class is ever found.
  ⚠️ **A KILLED RUN LEAVES ITS IN-FLIGHT MUTATION IN THE TREE.** The revert is a `finally`, and a `finally`
  does not run when the process is killed — so cancelling the gate mid-rung leaves a production file carrying
  `if (false)` (or whatever that rung writes). The next run refuses to start on it, which is the guard
  working; a COMMIT in between ships it. After stopping the gate for any reason, `git diff HEAD --name-only`
  and restore what it names before doing anything else. Do not run it concurrently with edits to a file it
  mutates, for the same reason.
- `pnpm lint` is check-only and safe to run repo-wide; **fixes** stay scoped to files you
  changed — never run repo-wide formatters in this shared WIP tree.
  ⚠️ **`biome check --write` DOES NOT APPLY BIOME'S "UNSAFE" FIXES**, and it exits 0 anyway. `useTemplate`
  and `noUnusedTemplateLiteral` are both in that class, so a file can come back from `--write` reporting
  success and still fail `pnpm lint` — which is how a lint-red commit got made in arch-review 69, found only
  because an unrelated probe happened to run the commit gate over it. Running the formatter is not evidence;
  `pnpm lint` afterwards is. This is the same shape as the substitution-that-silently-missed in arch-review
  67: the tool said nothing, and nothing is not confirmation.
- **`trust-fast` is a REQUIRED check and `pnpm ci:local` does not cover it.** `.github/workflows/trust-fast.yml`
  (job name **`trust fast (real Postgres)`**) runs the trust subset that needs a real Postgres **and a real
  object store** on every push and PR, through `scripts/trust/trust-suite.mjs` so that a scenario which
  SKIPPED still fails the check. Scope = `apps/api/src/trust` minus the Temporal durability files, **plus
  `packages/` and `apps/agent`** — those two were nightly-only until arch-review 56, which is how a signature
  change left a package's scenario red for a day where the required check could not see it. MinIO joined in
  arch-review 68 for the same reason one level down: four reviews had repaired the two-phase intermediates
  against a MOCKED 412, and deleting the conditional create leaves that counterexample 4/4 green while a real
  endpoint silently overwrites. The local gate deliberately boots neither, so this is the one required check
  you cannot pre-run with `ci:local`; reproduce it against a THROWAWAY Postgres and a THROWAWAY MinIO (the
  suite migrates whatever database you give it — never point it at a dev stack) with
  `EVERDICT_TRUST_DATABASE_URL=… EVERDICT_TRUST_S3_ENDPOINT=… EVERDICT_TRUST_S3_ACCESS_KEY=…
  EVERDICT_TRUST_S3_SECRET_KEY=… node scripts/trust/trust-suite.mjs apps/api/src/trust
  '!apps/api/src/trust/temporal-' packages apps/agent`.
- **A trust scenario that SKIPS is not a passing one, and locally that is the default.** Without
  `EVERDICT_TRUST_DATABASE_URL` these files skip, so `pnpm test` going green says nothing about them. After
  changing anything a trust scenario asserts on — a return type especially, since `expect(x).toBe(false)`
  still compiles when `x` becomes an object — run the suite against a real Postgres before pushing.
  A change to a trust-suite subject (the commit ledger, the fences, the settle path) runs it BEFORE pushing.
  What still stays nightly is Temporal and Windows (`trust-nightly.yml`, non-blocking) — MinIO does not, as
  of arch-review 68; see `docs/trust-certification.md`.
- A failure you did not cause (someone else's WIP / earlier commit) still blocks your push:
  surface it to the maintainer instead of silently absorbing or bypassing it.
- After pushing, confirm the run went green:
  `gh run watch $(gh run list -L1 --json databaseId -q '.[0].databaseId') --exit-status`.
