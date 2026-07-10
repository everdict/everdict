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
- No I/O in either. Contracts = pure types, Zod schemas, error classes, and the job-result wire codec.
  Domain = pure business logic (aggregates, version algebra, scoring/suite semantics, the authz matrix, placement
  policy) over the contracts — still no I/O, no SDKs.
- Every contract has a paired **Zod schema** — the schema is the source of truth; derive the type with `z.infer`.
- Interfaces (`Driver` / `EvaluableHarness` / `Grader` / `Environment`, plus the store/registry/`Dispatcher`
  ports the application layers own) live in the contract/port root; implementations live in adapter packages.
  This is the one deliberate inversion of the single-impl "no interfaces" rule — Everdict is a plugin runtime.
