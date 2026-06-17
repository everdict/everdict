# Conventions reference (reinterpreted from digo-api)

## Naming
- Files/dirs: lowercase-kebab, singular. Symbols: PascalCase types/classes, camelCase values, UPPER_SNAKE consts.
- Role suffix signals kind: `*Driver`, `*Harness`, `*Grader`, `*Environment`, `*.routes.ts`, `*.schema.ts`, `*.service.ts`, `*.repo.ts`, `*.test.ts`, `*.scenario.test.ts`.
- DTO naming: `{Resource}{Action}Request` / `{Resource}{Action}Response`; default representation drops the action.
- No abbreviations (spell out `description`, not `desc`); domain-standard short forms (`id`, `url`) are fine.

## Error model (exceptions, flat envelope)
- `AppError` base (abstract `status`) + subclasses: `BadRequestError`(400) `NotFoundError`(404) `ConflictError`(409) `RateLimitError`(429) `UpstreamError`(502) `InternalError`(500).
- `ErrorCode` is a code→message map; HTTP status is NOT in the code — it derives from the subtype (digo idiom).
- Envelope is flat: `{ code, message, data? }` via `AppError.toEnvelope()`. No `{error:{...}}` nesting.
- External/SDK failures are REMAPPED to our `AppError` (misconfig→5xx, upstream-5xx→502, 429→429) — never propagated raw, so monitoring blames us, not the user.

## Null discipline
- No `!` (narrow or `throw`). No silent defaults (`?? ""`, `?? 0`). Keep null explicit; throw if required here.
- Zod `.parse()` throws on a bad enum — no `UNKNOWN` fallback.

## Persistence (when DB lands — Drizzle + Postgres)
- snake_case columns; FK = `ref_{table}_id` (digo idiom). Base columns: `id` (uuid), `created_at`, `updated_at`.
- Migrations follow expand→deploy→contract phasing with a preflight check per migration (see `docs/migration/`). Destructive changes are reviewed runbooks, not auto-applied on deploy.

## Language policy
- skill/rule bodies → English. Code comments + OpenAPI `summary` → Korean. User-facing → Korean.

## Commits
- Conventional Commits, scoped: `feat(drivers): ...`. Body explains *why*. Every `fix:` ships a regression test.
