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
