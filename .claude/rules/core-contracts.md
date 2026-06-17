---
paths: "packages/core/**"
---
# Core contracts rules (push)

`core` is the dependency ROOT. See skill `core-contracts`.

- MUST NOT import from `drivers` / `harnesses` / `graders` / `runner` / `apps/*` or any SDK.
- No I/O. Pure types, Zod schemas, and error classes only.
- Every contract has a paired **Zod schema** — the schema is the source of truth; derive the type with `z.infer`.
- Interfaces (`Driver` / `EvaluableHarness` / `Grader` / `Environment`) live HERE; implementations live in adapter packages. (This is the one deliberate inversion of digo-api's "no interfaces" rule — Assay is a plugin runtime.)
