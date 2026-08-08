---
paths: "packages/{contracts,domain}/**"
---
# Contracts + domain kernel rules (push)

`@everdict/contracts` is the dependency ROOT; `@everdict/domain` is the pure business kernel over it.
See skill `core-contracts`. (These were `@everdict/core` before the re-architecture — `core` split into
`contracts` [types/schemas/errors] + `domain` [the kernel]. `suite`/`run-case`/`billing` also folded into
this spine.)

- `@everdict/contracts` MUST NOT import from `domain` / any adapter (`drivers` / `harnesses` / `graders` /
  `application-*` / `db` / …) / `apps/*` or any SDK. `@everdict/domain` may import ONLY `@everdict/contracts`.
- No I/O in either. Contracts = wire/Zod schemas, portable interfaces, error classes, the job-result wire
  codec, **and pure/total KERNEL functions that must cross dependency cones** (`isMeasured`/`sanitizeScore`,
  `envelopeAllows`→`authorizeToolInvocation`/`budgetExhausted`, `effectsRequireConsent`, `metricMatches`/
  `caseMatches`, `resolvePlacementOs`, `resolveHarnessInstance` — decisions a lower-cone consumer like
  `agent-runtime`/`job-runner` must execute without a domain dep). Admission test for a contracts function:
  no I/O, no registry/store access, no workspace policy, a pure TOTAL decision, AND a consumer beneath the
  domain cone — otherwise it belongs in `domain`. Domain = pure business logic (aggregates, version algebra,
  scoring/suite semantics, the authz matrix, placement policy) over the contracts — still no I/O, no SDKs.
- Every contract has a paired **Zod schema** — the schema is the source of truth; derive the type with `z.infer`.
- Interfaces (`Driver` / `EvaluableHarness` / `Grader` / `Environment`, plus the store/registry/`Dispatcher`
  ports the application layers own) live in the contract/port root; implementations live in adapter packages.
  This is the one deliberate inversion of the single-impl "no interfaces" rule — Everdict is a plugin runtime.
