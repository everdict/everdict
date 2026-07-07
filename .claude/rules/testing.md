---
paths: "**/*.test.ts"
---
# Testing rules (push) — Vitest idioms

See skill `testing`.

- Vitest only. Units = `InMemory*`/fake-`Dispatcher`; the API surface via `buildServer` + Fastify `inject` (the file-local `server()` factory in `server.test.ts`, not ad-hoc wiring); Pg store logic via a fake `SqlClient` (assert the SQL text/params). **No Testcontainers** — real-DB/Nomad/K8s/MLflow checks are env-gated `*.scenario.test.ts` / `scripts/live/*.mjs`. See skill `testing`.
- Test descriptions in **English** BDD style: `it("a user can submit their own suite", ...)`. Given/When/Then structure.
- File suffix: `*.test.ts` (unit/integration), `*.scenario.test.ts` (E2E).
- Cover business logic, permissions, error/edge cases (400/403/404/409), validation. Skip trivial CRUD and framework behavior.
- Every `fix:` ships a regression test that FAILS on the pre-fix code, named after the fixed behavior.
