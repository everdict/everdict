---
paths: "apps/api/**"
---
# API layer rules (push) — Fastify reinterpretation of digo-api's controller idioms

See skill `api-layer`.

- Three-file split per resource: `*.routes.ts` (registration) + `*.schema.ts` (Zod req/res + OpenAPI) + `*.service.ts` (logic). Routes never contain business logic; services never touch HTTP.
- Responses are **flat** — no success envelope. Error envelope is flat `{ code, message, data? }` from `AppError.toEnvelope()`.
- POST default status = **200** (201 allowed, but be consistent within a resource). No `/api` prefix.
- List endpoints are paginated by default (cursor: `created_at DESC, id DESC`, fetch `size+1`, opaque base64 token). No `pagination` wrapper.
- OpenAPI `summary` text is **Korean** (language policy). 
- `/internal/**` routes are guarded by `x-internal-token` (constant-time compare, fail-closed if unset); no end-user auth context.
