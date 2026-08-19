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
- **A field the receiving type does not declare survives the call and becomes unreadable.** Excess-property
  checking applies to object LITERALS only, so `f(ctx)` where `ctx` carries a field `f`'s parameter type omits
  compiles clean and the property is still there at runtime — but nothing downstream can read it without a
  cast, so nothing does. The value is not dropped; it is silently *unconsumed*, which looks identical from the
  outside and is harder to notice, because the sending side's comment says it travelled. So a value that must
  survive a hop (an idempotency key, a causer id, a fence) is declared on **one shared contract type** used by
  both ends, never re-declared per layer — `idempotencyKey` reached the sink object and no adapter could see it.
- **A value BUILT at a call site is checked by the parameter type or by nothing** — so never `f({ … } as never)`
  or `as unknown as T` on an object you just constructed. `pnpm constructed-casts` refuses it (CI-required).
  This is not style: arch-review 57 found the verifier lane unable to produce any verdict in production, and
  the first of its four independent breakages was `driver.provision({ image } as never)` against a
  `ComputeSpec` that requires `os` — the driver refused on its first line, and the cast is why the build was
  green over a call that could never succeed. Removing that one cast then surfaced three more real defects the
  compiler had been holding: a missing `tags`, an optional `tenant` flowing into runtime resolution, and a
  `GradeContext` missing every required field. Type the call; if the type genuinely cannot say it, add an
  allowlist entry stating why.
- **Model a decision as a discriminated union, never `{ value?: T; ok: boolean }`.** A caller can read the
  value and never look at the flag — and will. Exhaustive `switch` on `kind` is the shape that cannot be
  half-consumed. See rule `protocol` L2.
