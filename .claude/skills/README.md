# Convention system — the map

Everdict's build knowledge for THIS codebase is split by **how the knowledge fails**, not by topic: rules
(pushed while you edit) and skills (pulled when you need them), with `docs/` as the product's record layer —
reasons and design records. How the work itself is planned, reviewed and remembered is not kept in this
repository: it accumulates in Everdict (`docs/architecture/development-system-of-record.md`).

| | PUSH — `.claude/rules/*.md` | PULL — `.claude/skills/*/` |
|---|---|---|
| How it reaches you | frontmatter `paths:` glob → auto-injected when a matching file is read or edited | matched on the skill's `description:`, or invoked as `/name` |
| What it owns | short rules that **conflict with ecosystem defaults** — what you would otherwise do "the standard TS way" and get wrong here | **look-up knowledge you know you are missing** — recipes, domain models, subsystem specifics |
| Failure mode it prevents | a convention nobody remembers at the moment of editing | a design decided without the context that already exists |
| Size | thin (~20–40 lines): the non-default rules inline, plus a pointer to the skill. Incident history is a record and goes to `docs/` | slim `SKILL.md` (≤~100 lines) + `references/` for depth |

**Two checks keep this map honest**, because a rule is documentation the MODEL reads: it arrives
by a glob at the moment of editing, and nobody is reading it deliberately enough to notice that it went stale.
`pnpm docs-check` verifies that every repo path a rule or skill cites still exists (the same predicate it
applies to `docs/**` — widening it found 29 dead paths across 7 skills) AND that every backticked symbol is
one this repo actually declares (which found three more, including an interface two documents still taught
two reviews after it was deleted). A name that is gone may still be written — without backticks.
`pnpm convention-harness` covers the structure, and refuses:
1. a rule with no `paths:` frontmatter — always-on by accident is not design;
2. a `paths:` glob matching nothing — a rule pointed at moved code is not weak, it is ABSENT, and silently
   (`suite.md` carried 10 KB of settlement rules aimed at a package the re-architecture had folded away; it
   fired for nobody for months, and later reviews found exactly those invariants broken);
3. a rule referenced from `CLAUDE.md`/this file that does not exist;
4. a skill with no `name:`/`description:` — the pull layer cannot offer it;
5. **a workspace no rule chose and no skill names** — the other direction, added arch-review 56. Repo-wide
   globs (`**/*`, `**/*.ts`, `**/*.test.ts`) are excluded from that count on purpose: counting them makes the
   check vacuously green over the blank regions it exists to find. Four packages were unmapped when it landed.

---

## PUSH — the 27 rules, by what they govern

**Always on** (repo-wide, so they stay short)
- `typescript` `**/*.ts` — no `any`, no `!`, no silent nullable defaults; Zod at every boundary; `AppError`
  subclasses only; discriminated unions over `{value?, ok}`.
- `testing` `**/*.test.ts` — Vitest idioms, and the **vacuous-pass rules**: a counterexample is seen RED *for
  the stated reason*, a fixture comes from the production builder and must actually reach the predicate, a
  deleted subject re-proves its tests by mutation, an empty `describe` fails the suite.

**The cross-cutting one**
- `protocol` — the **five laws** for the seam between a decision and an effect, pushed across the kernel and
  the control plane because that is where this repo's defects recur, and they recur as *correct nouns
  consumed as annotations*, which no layering rule can see. The rule carries the laws, the definition of done,
  and a one-line index of the 46 corollaries (e.g. **a comment that promises another component's behaviour is
  a claim, and the claim is what needs the test**); each corollary's incident is in skill `protocol`.

**The layer spine**
- `core-contracts` `packages/{contracts,domain}` — contracts is the dependency ROOT (no I/O, no SDKs); domain
  is the pure kernel over it. What may live in contracts vs domain, and the admission test.
- `suite` `packages/{domain,application-execution,application-control}` — batch evaluation and version
  regression: scoring authority, sealed plans, gate arithmetic, the settlement rules.
- `events` — platform facts ride state transitions; the closed kind vocabulary; the E0 outbox.

**Execution and placement**
- `drivers` · `harnesses` · `graders` · `environments` · `job-runner` · `backends` · `orchestrator` ·
  `topology` — one per package: the Driver/Harness/Grader/Environment contracts, the dispatched unit, backend
  placement + capabilities, Temporal determinism, service-topology harnesses.

**Data, registries, and the door**
- `db` · `registry` · `datasets` · `images` · `trace` — stores and migrations, versioned SSOT, task-format
  on-ramps, the managed image store, trace sources/sinks. (`packages/storage` has no rule of its own: it is
  inside the `events` and `protocol` globs, which are the conventions its adapters actually need.)
- `api-layer` `apps/api` — the transport-slice idiom: `api/<domain>` over services in `application-control` and
  models in `domain`, thin routes, BFF↔MCP parity.
- `mcp` · `auth` · `web` · `workspace-integrations` — the agent-facing tool surface, the auth core, the
  Next.js app, and the per-workspace integrations.

**User-facing surfaces** (nothing in the monorepo imports these)
- `sdk` — the one-call HTTP client; a method needing something the API does not expose is a missing endpoint.
- `otel` — the OTLP-door helpers, **dependency-free by design**; the semconv copy is drift-guarded by test.

**Operations**
- `infra-deploy` `deploy/**` — compose/K8s/Helm, secrets, GitOps.

---

## PULL — the 16 skills, by what they answer

- `protocol/` — **effects and authority**: the five laws in full, the design checklist to run BEFORE writing
  an effect path, the **case law** (every recurring defect with file, line, and the wrong reasoning verbatim),
  the **corollaries** the rule indexes by heading, and the verification protocol (mutation-first, non-vacuous
  fixtures, when a scanner is legitimate).
- `foundation/` — module dependencies, the spine, the error model, repo-wide conventions.
- `core-contracts/` — the interfaces, Zod schemas and `AppError` model in `packages/contracts` (the dependency
  root) and the kernel in `packages/domain`.
- `evaluation/` — the eval domain: graders, judges, scorecards, regression/leaderboard, saved views, ingest.
- `evolve/` — **driving an evolution campaign**: the loop over everdict's own doors (freeze a frame, log
  rounds whose verdict the platform derives, spend the adoption the gate authorizes), the frame fields and
  their three waivers, and every refusal with its repair. The record is a settlement, not an engine — this
  skill is the driver it deliberately does not ship.
- `graders/` — implementing one Grader (recipe). The scoring *domain* is `evaluation`.
- `harnesses/` — implementing an EvaluableHarness (the agent under test) + trace normalization.
- `drivers/` — implementing a Driver (in-sandbox compute: `LocalDriver`, `DockerDriver`).
- `backends/` — distributed execution: Backend vs Driver, `CaseJob`, and the SaaS operational layer
  (capacity-aware + tenant-fair `Scheduler`, trust zones, secrets, budgets, autoscaling).
- `topology/` — service-topology harnesses: `HarnessSpec(service)`, warm pools, Nomad + K8s, trace wiring.
- `api-layer/` — the control-plane HTTP surface: async submit/poll, stores, flat envelopes, route recipes.
- `web/` — the SaaS web app: Next.js FSD, the pure-HTTP token-courier BFF, `[workspace]` scoping, UI idiom.
- `self-hosted-runner/` — the lease loop, the runtime/capability model, personal vs workspace runner tiers.
- `desktop/` — the Electron shell: renders the deployed web, origin-gated bridge, embedded runner.
- `agent-runtime/` — the agent kernel: `runAgentLoop`, `ToolDefinition`/`ToolRegistry`, the envelope + consent
  gates, sub-agents, MCP bridging.
- `testing/` — Vitest, fake-injection units, `buildServer`+`inject`, env-gated live E2E (no Testcontainers).

---

## Product invariants, and the check that refuses each

A rule or skill is advisory; each invariant below also has a check under `scripts/` that fails when it breaks.
Run the one a change touches; none of them runs on its own.

| Invariant | Taught by | Checked by |
|---|---|---|
| a failed read is a third value, never an empty result | skill `protocol`, rule `protocol` | `pnpm swallowed-reads` · `pnpm gated-doors` |
| a field the platform authors is not read off a producer's document | skill `protocol`, rule `protocol` | `pnpm untrusted-ingress` · `pnpm authz-optional` |
| a protocol's test goes red when the protocol is removed | rule `protocol`, rule `testing` | `pnpm protocol-mutations --only <rung>` · `pnpm mutation-leak` |
| a scanner states the vocabulary it watches, and it must be live | this file | `pnpm scanner-watches` |
| a rule reaches live paths and a skill has a description to match on | this file | `pnpm convention-harness` · `pnpm docs-check` |
| the web app imports nothing from the runtime | rule `web`, skill `web` | `pnpm web-imports` · `pnpm web-reach` |
| the job runner's dependency cone is closed | rule `job-runner` | `pnpm cone` · `pnpm import-cycles` |
| the source is English; Korean is product data under test | CLAUDE.md | `pnpm language-policy` |
| a trust scenario that skipped certified nothing | rule `testing`, CLAUDE.md | `pnpm trust-fast` · `pnpm trust-certified` |

## Working rules for this map

- **Skills travel with the code.** A PR that changes a convention or an invariant updates the matching rule or
  skill reference *in the same PR*. Implementation churn is not a doc trigger; a changed rule is.
- **A new package or app arrives with its rule** — check (5) above fails otherwise, which is the point.
- **No hypothetical surface.** A rule describing something with no current caller is removal grounds. The same
  goes for a doc describing a plan that shipped: the code is the map then, and stale addresses mislead.
- Language: every rule and skill body is **English** (see CLAUDE.md's language policy).
