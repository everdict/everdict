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
- Identity comes from the **auth core** (`@assay/auth`): `Authorization: Bearer <jwt|ak_…>` →
  `Principal{subject,workspace,roles,via}` (OIDC/Keycloak + API key, composed). With `requireAuth` a
  missing/invalid credential is 401, else dev falls back to `x-assay-tenant` (admin). Gate mutating routes with
  `authorize(principal, action)` (403 on deny); EVERY read/write is **workspace-scoped** (runs + harnesses) —
  never trust a client-supplied tenant when auth is on; another workspace's resource reads 404, not 403. See
  `docs/auth.md` + rule `auth`.
