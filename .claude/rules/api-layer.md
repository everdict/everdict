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
- `/internal/**` routes are guarded by `x-internal-token` (constant-time compare, fail-closed if unset); no end-user auth context. `POST /internal/tenant-keys` issues API keys.
- Tenant identity comes from `Authorization: Bearer ak_…` → `TenantAuth` (`@assay/db`, key→tenant); with
  `requireAuth` a missing/invalid key is 401, else dev falls back to `x-assay-tenant`. EVERY read/write is
  tenant-scoped (runs + harnesses) — never trust a client-supplied tenant when auth is on. API keys: store only
  the SHA-256 hash, return plaintext once.
