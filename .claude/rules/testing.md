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

## A test must PROVE what it claims (push) — the vacuous-pass rules

Green is not evidence. This repo has now shipped three suites that were green over the exact gap they were
written to close. Each was vacuous in a different way, so each way is a rule. Skill `protocol` holds the cases.

- **A counterexample is seen RED, and the red message NAMES THE INVARIANT.** Red because a fixture field was
  missing, a helper threw, or an import was wrong proves nothing. Record the observed failure text in the
  test's header comment; if it does not describe the defect, the test is not pinning the defect.
- **A fixture is derived from the PRODUCTION builder and must actually reach the predicate.** A fixture built
  by hand asserts against a shape no production path emits. A fixture built by the real builder but with inputs
  the predicate ignores produces an EMPTY result that every "is it defined?" assertion accepts.
  So: assert the derived collection is **non-empty and has the expected cardinality** before asserting its
  properties. `expect(receipts).toBeDefined()` is not a claim — `[]` is defined. `toHaveLength(n)` is.
- **A deleted or refactored subject re-proves its tests by MUTATION, not by staying green.** An assertion like
  "X was not called" becomes vacuously true the moment X stops existing. After any deletion, run
  `pnpm protocol-mutations`; a protocol that stays green under its own neutralization has lost its test.
- **An empty `describe(...)` FAILS the suite** ("No test found in suite") — and only in a full run, not when
  you run the file alone. Delete the block; never leave a shell where tests were removed.
- **A guard/scanner is reverted once to confirm it goes RED** over the defect it was written for. Two scanner
  drafts here were green over their own target. A guard nobody saw fail is a comment.
- Cover the DEGRADED read too, not only the happy and the absent one: store throws, cluster 5xx, ledger
  unreadable. Those are the paths that produce a wrong decision rather than a visible error.
- **A double for a GUARDED write answers the way the real one would.** `transition` returns `false` when it
  refuses; a double hard-coded to `true` turns a guard that rejects every real call into a green test, and
  the assertion "we recorded the close" then proves only that we ASKED. Where an `InMemory*` implementation
  exists, use it — it is cheap and it is the same decision production makes. And assert the row's STATE, not
  that the call happened (rule `protocol`, the always-succeeds-double law).
- **A fixture whose ids all match is not the production shape.** A scorecard child's `id` is a random row id
  and its `executionId` is a different string; a test that sets them equal cannot see a lookup using the
  wrong one, which is how a recovery that finds no handles at all stayed green (arch-review 63 P0).
