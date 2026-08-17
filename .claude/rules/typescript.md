---
paths: "**/*.ts"
---
# TypeScript rules (push)

Non-default rules — see skill `foundation` for rationale.

- No `any`; no non-null assertion `!` — narrow, or `throw` an `AppError`.
- No silent defaults for nullable domain values (`?? ""`, `?? 0`, `getOrDefault`). Keep null explicit; throw if the value is required at this layer. (boundary `default` in Zod is the only exception)
- Validate every external boundary input with a Zod schema; `.parse()` throws on a bad enum (no fallback).
- Named exports only (no `default export`). Import types with `import type`.
- Errors: throw a subclass of `AppError` from `@everdict/contracts`. Never throw raw `Error` across a package boundary; never propagate an SDK/HTTP error as-is — remap it.
- Directories & files: lowercase-kebab, singular. No abbreviations (`description`, not `desc`).
- **A forwarded object silently drops what the receiving type does not declare.** Excess-property checking
  applies to object LITERALS only — `f(ctx)` where `ctx` carries a field `f`'s parameter type omits compiles
  clean and loses the field. So a value that must survive a hop (an idempotency key, a causer id, a fence) is
  declared on **one shared contract type** used by both sides, never re-declared per layer. Re-declaring is
  how `idempotencyKey` reached a composition seam and vanished under a comment saying it travelled.
- **Model a decision as a discriminated union, never `{ value?: T; ok: boolean }`.** A caller can read the
  value and never look at the flag — and will. Exhaustive `switch` on `kind` is the shape that cannot be
  half-consumed. See rule `protocol` L2.
