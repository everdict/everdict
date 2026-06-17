---
paths: "**/*.test.ts"
---
# Testing rules (push) — Vitest reinterpretation of digo-api's testing idioms

See skill `testing`.

- Vitest only. E2E/integration over Testcontainers (Postgres); boot the app via the shared scenario helper, not ad-hoc wiring.
- Test descriptions in **Korean** BDD style: `it("유저가 자신의 suite를 제출할 수 있다", ...)`. Given/When/Then structure.
- File suffix: `*.test.ts` (unit/integration), `*.scenario.test.ts` (E2E).
- Cover business logic, permissions, error/edge cases (400/403/404/409), validation. Skip trivial CRUD and framework behavior.
- Every `fix:` ships a regression test that FAILS on the pre-fix code, named after the fixed behavior.
