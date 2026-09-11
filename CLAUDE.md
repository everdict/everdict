# Everdict — Agent Harness Evaluation Runtime

> Everdict = **eval + verdict**: run any agent harness, get a defensible verdict.
> A **harness-agnostic, infra-agnostic** runtime that runs and **evaluates** arbitrary
> agent harnesses (Claude Code, Codex, LangGraph, …) across environments (repo / browser /
> os-use) and OSes (Linux / Windows / macOS). Eval-first; just enough operational runtime
> to drive long/stateful/isolated runs.

## 🚨 Documentation-first — read before you code
Always read the relevant skill in `.claude/skills/` **before** writing code. No exceptions.
Read the matching `<area>/SKILL.md` first, then pull `references/*.md` on demand.
`.claude/` is the **single source of truth** for how we build.

## 🚨 Review-first — load skill `code-review` before reviewing anything
ANY review — a diff, a branch, a PR, a batch before push, or a self-review of what you just wrote — starts by
loading skill `code-review` and running its six passes. No exceptions, and **especially not for a self-review**:
that is the case it was written for. Three self-review rounds over one batch found real defects and missed
three P0s an outside review found immediately, using no information the author did not have — because every
round reviewed the CHANGE and none asked who can author the values it made load-bearing. Reading the diff is
the last pass, not the first. A review that stops at "the gates are green" has reported the gates' opinion:
no gate here can see a forged capability, a bound composed with an unbounded neighbour, or SQL no engine has
planned.
The skill has now failed TWICE and been paid for twice. The second failure is the one to remember: six passes
all phrased "for every value **this change** …", against three P0s that lived in code the batch never touched
and had merely come to DEPEND on — a parser it cited instead of opening, a two-statement seal it started
reading as evidence, a sibling query it forgot to teach. Reviewing what you wrote is not the same as
reviewing what you now rest on.

## Language policy (public repo — English-only source)
- Everything in the repo is **English**: docs, code comments, log/error messages, OpenAPI summaries,
  test descriptions, commit messages, PR titles/bodies.
- The ONLY Korean in the repo is **ko-locale product data**: `apps/web/messages/ko.json` and inline
  ko-locale dictionaries/fallbacks (e.g. `shared/lib/{format,clipboard,cron}`), plus test assertions
  on that ko output, plus the ONE named agent-eval stimulus whose language IS the fixture
  (`evals/cases/english-only-source.json` — a Korean request that must still produce English source).
  Each further one is argued and listed individually, never by directory. The Korean is always an input
  under test, never the repository's own prose.
- Web UI strings → **message catalogs** (`ko`/`en`), never hardcoded in components (see `docs/web.md`).
- Conversation with the maintainer stays Korean (preference); repo artifacts do not.

## Essential commands (run in this order)
1. `pnpm format`   — Biome format (always first)
2. `pnpm lint`     — Biome check (format + lint, single tool = ktlint reinterpretation)
3. `pnpm typecheck`— `tsc --noEmit` across packages (turbo)
4. `pnpm test`     — Vitest across packages (turbo)
5. `pnpm build`    — turbo build
⚠️ `biome check --write` does NOT apply Biome's **unsafe** fixes and exits 0 anyway, so a file can come back
from it reporting success and still fail `pnpm lint`. Running the formatter is not evidence; `pnpm lint` after
it is. (Found by the agent-eval suite: asked "biome exited 0, is lint green?", the answer cited this file's
five commands and never reached the rule that records the trap — `.claude/rules/ci.md` is injected while you
EDIT, and the question is asked before anything is touched.)
Quality is non-negotiable: all five must pass before a PR.
**Before ANY `git push`: `pnpm ci:local`** — the five commands above PLUS `pnpm cone` + `pnpm web-imports` +
empty-env boot + the self-contained web job + full-history gitleaks; it stamps `.git/everdict-ci-ok` on a
clean green tree and a PreToolUse hook denies unstamped pushes. See rule `.claude/rules/ci.md` + skill `ci`.
**There is NO remote CI.** Every GitHub Actions workflow was disabled on 2026-08-21 and DELETED on
2026-09-11 by the maintainer's decision (declared-limits C3): `ci:local` is not a mirror of a pipeline, it IS
the pipeline, and there is no run to watch after a push. Never push red.
**`ci:local` does NOT run the trust suite**, and **skipping is the local default**. Two env vars,
deliberately separate (`apps/api/src/trust/trust-context.ts` says so in its own comment):
`EVERDICT_TRUST_SUITE=1` runs the suite AT ALL — absent, every `*.trust.test.ts` is `describe.skip` and
vitest exits 0 — while `EVERDICT_TRUST_DATABASE_URL` (and the S3/ClickHouse vars) only select which
infrastructure a scenario drives once inside that gate. So setting the URLs without
`EVERDICT_TRUST_SUITE=1` still reports every file SKIPPED. A scenario that skipped certified NOTHING, and a
skip and a pass are the same exit code. `pnpm trust-fast` carries
the required subset's scope and `pnpm trust-full` the whole tree; `pnpm trust-certified` (inside `ci:local`)
reports how long it has been and what has changed since. The hook guards every checkout that shares this
`.git`, linked worktrees included.

## The harness's own directories
- `intent/`   — where a change starts: `intent.md` → `spec.md` → `plan.md`, one directory per change. `pnpm intent-chain`.
- `evals/`    — the regression suite over the configuration that steers the AGENT (not the product's scoring domain). `pnpm agent-evals`.
- `releases/` — the authorization a release tag needs before it may leave. `releases/<tag>.md`, committed.
- `REVIEW.md` — the review policy `pnpm review` applies to every push carrying product code.
- `lessons/`  — what an incident taught: what was believed, what made it invisible, what would have caught it.
- `scripts/bands/`, `scripts/scan/`, `scripts/telemetry/` — what watches the harness, what reads code nobody touched, and what collects what files cannot answer.
See rule `.claude/rules/ci.md` for what each refuses and why; `docs/architecture/harness-observability.md` for what it can see about itself; `docs/architecture/harness-declared-limits.md` for the five clauses this deployment cannot satisfy and what reopens each.

## The change chain — `intent/` before code
A change whose *why* someone else would have to reconstruct starts as `intent/<YYYY-MM-DD>-<slug>/intent.md`,
gains a `plan.md` **in a later commit**, and closes with `Status: shipped` + `Shipped: <sha>`. An accepted intent
has a `spec.md` (`pnpm design`) or one line declining it — `Design: none — <why>` — and the third state is refused. `pnpm intent-chain`
asks git for that ordering, because a plan written after the diff reads exactly like one written before it —
the files cannot tell them apart and the commit graph can. See `intent/README.md`. A one-line fix needs none;
the test is whether the reason survives in the commit message alone.

## Architecture — one-way dependency, by concern
```
contracts ← domain ← { application-execution · application-control } ← { drivers · environments · harnesses · graders · llm · trace · db · registry · backends · auth · storage · images · datasets } ← job-runner ← { orchestrator · topology } ← self-hosted-runner ← { apps/cli · apps/desktop }

agent-runtime ← apps/agent          (the reference OWNER runtime — consumes the trust harness, is not part of it)
sdk · otel                          (user-facing surfaces: HTTP client / OTLP door helpers — nothing imports them)
```
The **layer spine** is `contracts ← domain ← application-{execution,control}`: contracts is the pure dependency ROOT (interfaces + Zod schemas + errors), domain adds the pure business kernel (aggregates, version algebra, scoring/suite semantics, authz matrix, policy), and the two application layers hold the use-cases + ports the adapter packages bind. (The former `@everdict/{core,suite,run-case,billing}` packages were folded into this spine in the re-architecture.)
Each package's role, its dependencies and its idiom are **pulled, not pushed**: skill `foundation` carries the
per-package table (`.claude/skills/foundation/references/architecture.md`), and the per-package rule under
`.claude/rules/` is injected by a `paths:` glob at the moment you edit that package. What stays here is the
part a session must not get wrong before it looks anything up — the direction of the arrows above.

Reverse imports are bugs. The same concern name recurs per package (vertical slices).

**Intra-package layout:** a package's `src/` stays flat until ~15 non-test files; beyond that, group into
**domain** subdirectories (tests colocated) with the barrel `index.ts` + the package's core contract kept at the
root. The barrel re-exports the same symbols, so grouping never changes the public surface (consumers are untouched).
See `packages/backends` (`placement`/`orchestrators`/`scheduling`/`policy`), `contracts` (`execution`/`harness`/`infra`/`records`),
`trace` (`sources`/`sinks`); `apps/web` (FSD) is the reference for large apps. Small packages stay flat by design.

### Two execution layers: Backend (placement) vs Driver (in-sandbox)
- **Backend** (`@everdict/backends`) = *placement*: dispatch a job-runner job to an orchestrator
  (Nomad/K8s/Windows) and return the `CaseResult`. Isolation = the orchestrator's runtime.
- **Driver** (`@everdict/contracts`/`drivers`) = *in-sandbox compute*: the agent runs the harness via
  `LocalDriver` inside its already-isolated job. See `docs/execution-backends.md`.

### ⚠️ Deliberate deviation: interfaces ARE used
Single-implementation codebases rightly ban interfaces for DI (exactly one impl per concept).
Everdict's *whole product* is pluggable adapters (many Backends / Drivers / Harnesses / Graders), so the
`@everdict/contracts` contracts MUST be interfaces. This is the one idiom we intentionally invert —
everywhere else (null discipline, error model, naming, layering) we keep the strict default.

## 🔒 The protocol laws — read `.claude/rules/protocol.md` + skill `protocol` BEFORE designing an effect path
Everdict sells a *defensible verdict*, so the seam between a decision and an effect is the product. Fifty-three
architecture reviews found the same defect class there, and never because a concept was missing: the right
noun existed and was then consumed as an **annotation** — optional, swallowed, re-derived, or advisory exactly
where the next effect begins. The five laws, in full with case law, in skill `protocol`:
1. **Authority before effect** — no external effect until a store RETURNED proof the identity is durable. An
   optional pre-effect hook is a request; a required proof parameter is a protocol. Writes a decision rests on
   never return `Promise<void>`.
2. **Unknown is unignorable** — a failed read is a third value (`ReadResult`), consumed by exhaustive match.
   Never `.catch(() => [])`, never `{value?, ok: boolean}`. An allowlisted scanner entry is a design admission.
3. **Provenance is born at the source** — never re-derive identity from rendered output (metric name → judge,
   latest row → winner, timestamp → attempt). A predicate written twice has already diverged.
4. **A settlement owns immutable bytes** — decisions reference frozen payloads by key+digest; `current` is a
   monotonic projection; an at-least-once effect's idempotency key lives in the PUBLIC contract.
5. **Completion is verified zero** — accepted ≠ gone. One verifier shared by the request path and the
   reconciler; "cannot find out" is an escalation field, never a terminal state.

**Definition of done for a protocol change**: counterexample seen RED *for the stated reason* → the change →
`pnpm protocol-mutations --only <rung>` red under neutralization (author-run; no longer a gate) → **the escape hatch deleted in the same change**. A test
that stays green after its subject is deleted is a lost test (rule `testing`, vacuous-pass rules).

## Writing a check: an empty corpus is not a pass
A `scripts/check-*.mjs` that finds nothing must first prove there was something to find. **Refuse to report
over an empty corpus** — no files matched, no routes extracted, no cases loaded — because a scanner with
nothing to look at reads exactly like coverage, and the failure is silent for as long as nobody asks. Three
checks here already encode it (`web-reach`, `scanner-watches`, `agent-evals`) and each was written after the
question was asked too late.

## Critical rules (the non-default ones — see `.claude/rules/`)
- No `any`, no non-null `!`, no silent nullable defaults; validate every boundary with Zod.
- Errors: throw an `AppError` subclass (`@everdict/contracts`); HTTP status derives from the subtype.
- External/SDK failures are remapped to our `AppError` (never propagated raw) so monitoring blames us, not the user.
- Cost/tokens come from the harness's own trace (e.g. Claude reports `total_cost_usd`); for LocalDriver the harness uses the machine's existing login (no API key).
- `ComputeHandle` is always released in a `finally`.
- Backends never run the harness; they dispatch the `@everdict/job-runner` image and parse its `__EVERDICT_RESULT__` stdout sentinel.
- Temporal workflow code (`@everdict/orchestrator` `workflows.ts`) MUST be deterministic — no I/O; side effects go in activities.

## Key principles
1. **Read first, code second — NO EXCEPTIONS.**
2. **Quality is non-negotiable** — format/lint/typecheck/test/build all green.
3. **Skills travel with the code** — a PR that changes a convention/invariant updates the matching skill reference *in the same PR* (mere implementation churn is not a doc trigger).
4. **Reinterpret, don't copy** — proven idioms from prior codebases are adapted to TS, not transplanted verbatim; note the source idea when non-obvious.
5. **New top-level domains pass the trust gate** — a new domain enters the spine only if it strengthens the
   trust harness (execution→evidence→measurement→verdict→regression→reproduction) or the owner protocol;
   otherwise it ships as an application/plugin on top. The agent runtime is a *reference owner runtime that
   consumes the trust harness* — not the product identity; complexity budget is measured in invariant upkeep,
   not feature count.

## Commits
Conventional Commits, scoped: `feat(drivers): ...`, `fix(runner): ...`. Body explains the *why*.
Every `fix:` ships a regression test that fails on the pre-fix code — `pnpm fix-proof` reads the first half (a
fix under `packages/**`/`apps/**` carries a `*.test.ts`, or declares `Regression-test: none — <why>` in its body)
and `pnpm ci:commits` proves the second (the test is RED with the source reverted to the parent).
