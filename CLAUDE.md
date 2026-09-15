# Everdict — Agent Harness Evaluation Runtime

> Everdict = **eval + verdict**: run any agent harness, get a defensible verdict.
> A **harness-agnostic, infra-agnostic** runtime that runs and **evaluates** arbitrary
> agent harnesses (Claude Code, Codex, LangGraph, …) across environments (repo / browser /
> os-use) and OSes (Linux / Windows / macOS). Eval-first; just enough operational runtime
> to drive long/stateful/isolated runs.

## Repository layout
```
apps/        deployable apps — api · web · cli · desktop · agent
packages/    the TypeScript libraries: the layer spine and its adapters (see Architecture)
clients/     published non-TypeScript clients (python)
plugin/      the Claude Code / Codex plugin (.claude-plugin/marketplace.json points at it)
examples/    sample agents, bundles, benchmarks, servers
deploy/      compose · keycloak · postgres · temporal · grafana
docs/        product documentation — guide/ (users) · architecture/ (design records) · runbooks/ · migration/
scripts/     code checks (check-*.mjs) · trust/ (the trust suite, protocol mutations) · live/ · dev/
.claude/     rules (pushed by `paths:` glob) · skills (pulled by name) · settings
```
This repository holds the PRODUCT only: code, product documentation, and the conventions of this code. **How
the work is planned, decided, reviewed and remembered is not kept here** — requests, specs, plans, decisions,
lessons and review findings accumulate in Everdict, through the Everdict plugin
(`docs/architecture/development-system-of-record.md`). A new top-level directory needs a recorded reason
(`docs/architecture/repository-layout.md`).

## 🚨 Documentation-first — read before you code
Always read the relevant skill in `.claude/skills/` **before** writing code. No exceptions.
Read the matching `<area>/SKILL.md` first, then pull `references/*.md` on demand.
`.claude/` is the **single source of truth** for how this code is built.

## Language policy (public repo — English-only source)
- Everything in the repo is **English**: docs, code comments, log/error messages, OpenAPI summaries,
  test descriptions, commit messages, PR titles/bodies.
- The ONLY Korean in the repo is **ko-locale product data**: `apps/web/messages/ko.json` and inline
  ko-locale dictionaries/fallbacks (e.g. `shared/lib/{format,clipboard,cron}`), plus test assertions
  on that ko output. Each one is listed individually in `scripts/check-language-policy.mjs`, never by
  directory. The Korean is always an input under test, never the repository's own prose.
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
it is.

**No CI runs anywhere.** Every GitHub Actions workflow was deleted on 2026-09-11 and there is no local pipeline
or push hook either: the five commands above, plus the check under `scripts/` for what a change touches
(`pnpm run` lists them — `swallowed-reads`, `untrusted-ingress`, `web-imports`, `docs-check`, …), are the
evidence there is.

**`pnpm test` does NOT run the trust suite**, and **skipping is the local default**. Two env vars, deliberately
separate (`apps/api/src/trust/trust-context.ts`): `EVERDICT_TRUST_SUITE=1` runs the suite AT ALL — absent,
every `*.trust.test.ts` is `describe.skip` and vitest exits 0 — while `EVERDICT_TRUST_DATABASE_URL` (and the
S3/ClickHouse vars) only select which infrastructure a scenario drives once inside that gate. A scenario that
skipped certified NOTHING, and a skip and a pass are the same exit code. `pnpm trust-fast` carries the required
subset against throwaway containers and `pnpm trust-full` the whole tree; `pnpm trust-certified` reports how
long since anything certified and what has changed since (`docs/trust-certification.md`).

## Architecture — one-way dependency, by concern
```
contracts ← domain ← { application-execution · application-control } ← { drivers · environments · harnesses · graders · llm · trace · db · registry · backends · auth · storage · images · datasets } ← job-runner ← { orchestrator · topology } ← self-hosted-runner ← { apps/cli · apps/desktop }

agent-runtime ← apps/agent          (the reference OWNER runtime — consumes the trust harness, is not part of it)
sdk · otel                          (user-facing surfaces: HTTP client / OTLP door helpers — nothing imports them)
```
The **layer spine** is `contracts ← domain ← application-{execution,control}`: contracts is the pure dependency
ROOT (interfaces + Zod schemas + errors), domain the pure business kernel (aggregates, version algebra,
scoring/suite semantics, authz matrix, policy), and the two application layers hold the use-cases + ports the
adapter packages bind. Each package's role, dependencies and idiom are **pulled, not pushed**: skill
`foundation` carries the per-package table, and the per-package rule under `.claude/rules/` is injected by a
`paths:` glob when you edit that package. Reverse imports are bugs. The same concern name recurs per package
(vertical slices).

**Intra-package layout:** `src/` stays flat until ~15 non-test files; beyond that, group into **domain**
subdirectories (tests colocated) with the barrel `index.ts` + the package's core contract at the root. The
barrel re-exports the same symbols, so grouping never changes the public surface. References:
`packages/backends`, `packages/contracts`, `packages/trace`; `apps/web` (FSD) for large apps.

### Two execution layers: Backend (placement) vs Driver (in-sandbox)
- **Backend** (`@everdict/backends`) = *placement*: dispatch a job-runner job to an orchestrator
  (Nomad/K8s/Windows) and return the `CaseResult`. Isolation = the orchestrator's runtime.
- **Driver** (`@everdict/contracts`/`drivers`) = *in-sandbox compute*: the agent runs the harness via
  `LocalDriver` inside its already-isolated job. See `docs/execution-backends.md`.

### ⚠️ Deliberate deviation: interfaces ARE used
Everdict's *whole product* is pluggable adapters (many Backends / Drivers / Harnesses / Graders), so the
`@everdict/contracts` contracts MUST be interfaces. This is the one idiom we intentionally invert — everywhere
else (null discipline, error model, naming, layering) we keep the strict default.

## 🔒 The protocol laws — read `.claude/rules/protocol.md` + skill `protocol` BEFORE designing an effect path
Everdict sells a *defensible verdict*, so the seam between a decision and an effect is the product. The defect
class that recurs here is never a missing concept: the right noun existed and was consumed as an
**annotation** — optional, swallowed, re-derived, or advisory exactly where the next effect begins.
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
`pnpm protocol-mutations --only <rung>` red under neutralization (author-run; not a gate) → **the escape hatch
deleted in the same change**. A test that stays green after its subject is deleted is a lost test (rule
`testing`, vacuous-pass rules).

## Writing a check: an empty corpus is not a pass
A `scripts/check-*.mjs` that finds nothing must first prove there was something to find. **Refuse to report
over an empty corpus** — no files matched, no routes extracted, no cases loaded — because a scanner with nothing
to look at reads exactly like coverage, and the failure is silent for as long as nobody asks.

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
3. **Skills and docs travel with the code** — a change to a convention/invariant updates the matching skill *in the same PR*, and a change that makes a product document false updates the document (its `anchors:` name the files it describes).
4. **Reinterpret, don't copy** — proven idioms from prior codebases are adapted to TS, not transplanted verbatim; note the source idea when non-obvious.
5. **New top-level domains pass the trust gate** — a new domain enters the spine only if it strengthens the
   trust harness (execution→evidence→measurement→verdict→regression→reproduction) or the owner protocol;
   otherwise it ships as an application/plugin on top. The agent runtime is a *reference owner runtime that
   consumes the trust harness* — not the product identity; complexity budget is measured in invariant upkeep,
   not feature count.

## Commits
Conventional Commits, scoped: `feat(drivers): ...`, `fix(runner): ...`. Body explains the *why*.
Every `fix:` ships a regression test that fails on the pre-fix code.
