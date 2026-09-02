---
kind: decision
title: "Harness definability — a client is a target, an environment is an entity, the case reaches the harness"
status: accepted
updated: 2026-09-02
anchors: [packages/contracts/src/harness/harness-spec.ts, packages/contracts/src/harness/harness-template.ts, packages/contracts/src/execution/environment.ts, packages/contracts/src/execution/eval-case.ts, packages/job-runner/src/registry.ts]
---
# Harness definability — a client is a target, an environment is an entity, the case reaches the harness

> **Status:** spec for Pillar 1 of `docs/architecture/evolution-program-gap-map.md` (gaps G1.1–G1.4). Nothing
> below is implemented unless a section says **Landed**. Each section names the counterexample that has to be
> RED before its change lands, because a definability gap closed without one is a schema that accepts more
> and a runtime that still does the old thing.

## What holds, and what this spec must not restate

Three harness kinds in one closed union (`packages/contracts/src/harness/harness-spec.ts`): `process`,
`service`, `command`. Template + Instance is the only registration path
(`packages/contracts/src/harness/harness-template.ts`; `docs/architecture/harness-taxonomy.md`). A `command`
template can now declare a `conversation` contract and be a delegation profile's agent
(`docs/command-harness.md`) — **Landed** 2026-09-02, the fix that the survey behind this spec exposed. The
environments a case can name are `repo | browser | prompt | os-use`
(`packages/contracts/src/execution/environment.ts`). A `service` harness may declare a `target` — where the
agent's actions land — and today that target is a browser: `TopologyTargetSchema.kind` is the literal
`browser`, `engine` the literal `chromium`, acquired by provisioning one or by asking a session API
(`TargetAcquireSchema`, mode `provision | service`).

## §1 — A client harness is a harness with a target, and a target is not always a browser (G1.1)

> **Landed 2026-09-02, the declaration and its acquisition:** `TopologyTargetSchema` is a discriminated union —
> `browser` (unchanged), `api` (`baseUrl` or `acquire.mode = service`, `openapi`, `auth`, `observe`), `os` (`acquire.mode =
> service`) — with `targetDefects` refusing an unobtainable target where the spec enters
> (`packages/contracts/src/harness/harness-spec.ts`). A `command` template may declare a static `api` target, carried
> onto the resolved spec, reaching the CLI as `{{target.baseUrl}}` and `EVERDICT_TARGET_BASE_URL`. The topology
> backend acquires an `api` target statically (`staticApiAcquirer`, wiring `target_base_url`) or through a session
> API; every browser-only read (extension image, saved profile, observation delivery) now narrows on the kind. **Not
> landed:** the recording proxy that observes an api client's exchanges as trace events, and any provisioning of an
> `os` target — both refuse by name today rather than pretend.

**The gap.** The program names "a client that interacts with an environment directly" as a harness shape.
Today that agent is written as a `command` whose CLI happens to be an HTTP client, or as a topology whose
`target` is a browser. Neither says what the agent IS: the CLI is a client of the thing under test, and the
thing under test has no declaration — so the experiment identity (`docs/architecture/evolution-lineage.md`
Track B) cannot say whether "the environment moved" between two runs, and the observation channel has nothing
to observe but the CLI's stdout.

**Decision.** `TopologyTargetSchema` becomes a discriminated union on `kind`, and a `target` may be declared
on a `command` template as well as on a `service` one:

- `browser` — unchanged.
- `api` — `{ kind: "api", acquire, openapi?: { ref }, auth?: { secretRef }, observe: ["request", "response"] }`.
  `acquire` reuses `TargetAcquireSchema` (a provisioned base URL, or a session API that hands one out). The
  agent receives the base URL through the same wiring the browser target uses for its CDP URL. The platform
  observes the client through a recording proxy the job-runner interposes — the same shape as the per-run
  LLM usage proxy in `docs/usage-metering.md` — emitting one trace event per exchange, a new event kind
  beside `llm_call` in `packages/contracts/src/execution/trace.ts`. Judges see what the client did, not what
  it printed.
- `os` — `{ kind: "os", os: "linux" | "windows" | "macos", observe: ["screenshot", "window"] }`. The
  `os-use` environment already exists per case; this is the same world declared as a topology's target so a
  deployed agent (not a CLI in the sandbox) can drive it.

**Rejected: a fourth harness kind `client`.** It would duplicate every field of `command` and `service`,
give the union's readers (`packages/job-runner/src/registry.ts`, the topology backend, the run service) a
fourth arm with no behaviour of its own, and still need the target declaration this section adds. The
target is the new thing; the kind is not.

**Counterexample (RED first).** A `command` template declaring `target: { kind: "api", … }` today loses the
field silently — the template object strips keys it does not declare — so nothing downstream sees it; after
the change it resolves, the job-runner
provisions the target, and a case run against it has recorded exchanges in its trace. The second half is the
one that matters: a target that resolves and is not observed is a declaration, not a capability.

## §2 — The environment is an entity: registered, versioned, diffed, evolvable (G1.2, G4.6)

> **Landed 2026-09-02, the entity and the identity axis:** `EnvironmentSpecSchema` is a registered document
> (`(tenant, id, version) → EnvironmentSpec`, `InMemoryEnvironmentRegistry` / `PgEnvironmentRegistry`, migration
> 0207, doors `POST/GET /environments` + `create_environment`/`list_environments`/`get_environment`, gated by
> the dataset action pair). A case names one with `env: { kind: "ref", id, version? }`; `resolveCaseEnvironments`
> resolves it at submit and SEALS the concrete version on the manifest (`environments`), and every execution
> lane — resume, retry, the Temporal driver, the single run — re-resolves through that seal rather than through
> a fresh `latest` read, refusing when the document's bytes have moved. `EXPERIMENT_AXES` gains `environment`,
> so two batches over one dataset and two environment versions read as an environment confound instead of as a
> change to the harness under test. **Not landed:** the `service` environment kind (nothing provides one yet, so
> the schema would be a plan), a `source`+`build` recipe for environments, and `subject.type: "environment"` —
> a campaign still evolves an agent or a harness.

**The gap.** A case EMBEDS its environment (`EvalCase.env`), a topology embeds its target, and a campaign's
subject is `agent | harness` (`packages/contracts/src/records/evolution-campaign.ts`). So the environment —
the seed repository, the browser fixture, the OS image, the deployed service under test — has no identity of
its own. It cannot be versioned independently of the dataset that names it, cannot be the axis a comparison
verifies, and cannot be the subject a campaign evolves, although the program says it must be.

**Decision.** An environment registry, `(tenant, id, version) → EnvironmentSpec`, built like the harness,
dataset, judge and runtime registries in `packages/registry` (immutable versions, semver `latest`,
tenant-owned with `_shared` fallback). The spec is one of the existing environment kinds, plus `service` —
a topology the environment PROVIDES (the app under test as a set of services with a `target` the harness acts
on). A case may name its environment by reference, `env: { ref: { id, version } }`, resolved when the
execution plan is sealed and written into the manifest as a digest, exactly as the harness closure is. An
environment with a `source` + `build` recipe is built by the same lane a harness candidate is
(`packages/application-control/src/evolution/campaign-build-service.ts`, D2), and `subject.type` gains
`"environment"` so a campaign can evolve one.

**Rejected: the environment as a slot of the harness topology.** It reads naturally — "one more service" —
and it destroys the experiment: the harness is what ACTS, the environment is what is ACTED ON, and a
comparison that cannot tell which side moved cannot say what a delta is evidence about. The identity axes
must be able to name `environment` separately from `harness`.

**Counterexample (RED first).** Two scorecards over one harness version and two environment versions are
diffed. Today the experiment identity has no `environment` axis and the pair reads comparable. After the
change it reads `confound` on `environment`, and a campaign round over that pair is not comparable — the
same treatment two image digests already get.

## §3 — First-party recipes for the coding agents the program names (G1.3)

> **Landed 2026-09-02, for two of the three:** `examples/harness-templates` gains codex and claude-code-router
> templates (with instances), each a `command` harness with a `conversation` contract, a `source` + `build` recipe
> and a `source.maintainer`; the seed test asserts the contract survives resolution. The CLI resume forms and
> session-id patterns are the shapes those CLIs document today and are the part a workspace adjusts when a CLI
> changes them. **Hermes has no recipe yet**: its CLI's resume form is not confirmed, and a recipe that guesses it
> would register a "conversational" harness that cannot resume — the exact defect the contract exists to refuse.

**The gap.** Codex ships as a one-shot `command` recipe (`examples/bundles/codex-pinch/bundle.json`: `codex
exec … < /dev/null`, no `conversation`). Hermes appears only as an example name in an environment comment.
claude-code-router has nothing. `examples/harness-templates` holds aider, browser-use, desktop and langgraph
recipes. Until today a recipe COULD not be conversational through the registry; now it can, and none is.

**Decision.** Ship one template per agent under `examples/harness-templates` — codex, claude-code-router,
hermes — each with a `conversation` block (the resume form the CLI documents, a `token.pattern` that reads its
session id off the output), a `source` + `build` recipe so the agent's own scaffold is code-evolvable, and a
matching delegation profile example. A contract test parses every example template in that directory
through `HarnessTemplateSpecSchema` and asserts that a declared `conversation` survives
`resolveHarnessInstance` — the test written today for one fixture, generalized over the directory so the
next recipe cannot regress silently.

**Rejected: adapters in code** (a `CodexHarness` class beside `ClaudeCodeHarness`). The whole point of the
`command` kind is that a CLI agent is a declaration; a class per vendor is the design the kind replaced.

**Counterexample (RED first).** `create_sandbox` with a codex delegation profile answers 400 today (the
harness cannot resume). After the recipe lands it opens a session, and a second turn resumes it with the
token the first turn reported.

## §4 — The case reaches the harness, and a process harness has a box (G1.4)

> **Landed 2026-09-02.** `CASE_TOKEN_FIELDS` + `caseTokenDefects` (`packages/contracts/src/harness/harness-spec.ts`),
> refused at both doors (the resolved spec's refine and the template union's); `RunContext.evalCase` carries the
> case's id and environment declaration from the job-runner, and `CommandHarness` renders the tokens shell-quoted
> (`packages/harnesses/src/command.ts`); `ProcessTemplateSpecSchema.resources` rides the resolved process spec; and
> `harnessResourcesOf` is the ONE predicate the scheduler, the K8s manifest and the Nomad manifest read the harness's
> box through — each used to spell `kind === "command"` itself. `case.target.baseUrl` waits for §1.

**The gap.** A command template sees `{{task}}`, `{{model}}`, `{{run_id}}`, `{{conversation}}` and its own
`params` (`packages/harnesses/src/command.ts`); nothing carries the CASE
— its environment kind, its repository ref, its target's base URL — into the command. A harness that must
behave differently for a `repo` case and a `browser` case has to guess from the task text. And a `process`
template declares no `resources`, so a process harness runs in whatever box the runtime defaults to.

**Decision.** A `{{case.<field>}}` token family over an explicit allowlist — `case.id`, `case.env.kind`,
`case.env.repo.url`, `case.env.repo.ref`, `case.target.baseUrl` — rendered by the same shell-quoting
renderer `{{task}}` uses, refused at template parse for any field outside the list. `ProcessTemplateSpecSchema`
gains `resources`, the same shape `command` and `service` carry.

**Rejected: exposing the case document.** `{{case.*}}` over the whole `EvalCase` would let a template name
`case.tests` or the verifier environment — the material `verifierPlanOf` exists to keep out of the agent's
container (rule `protocol`; `docs/datasets.md`). An allowlist is the only shape that cannot leak it, and the
refusal at parse is what makes "cannot" true rather than "should not".

**Counterexample (RED first).** A template whose command names `{{case.tests}}` is refused at parse with the
allowlist in the message; a template naming `{{case.env.repo.ref}}` renders the case's ref. Today both stay in
the command as literal text — an unknown `{{var}}` with no matching param reaches the shell unsubstituted —
and nothing says so.

## What would reopen this

- A fourth kind of world — a mobile device, a hardware bench — that none of `browser | api | os` observes.
  §1 adds a union arm; the observation channel for it is the real work.
- An environment whose versions cannot be digested (a live third-party SaaS). §2 then records `unverified`
  on the environment axis, honestly, and the campaign frame has to waive it by name.
- A coding agent with no CLI (HTTP-only). §3 assumes a conversation is a CLI that resumes; such an agent
  needs an `api`-target harness that IS the agent, which is §1 pointed the other way.
