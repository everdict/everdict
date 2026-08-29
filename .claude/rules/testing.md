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
  `pnpm protocol-mutations --only <the rung>`; a protocol that stays green under its own neutralization has
  lost its test. No gate runs this any more (see rule `ci`) — the author does, and `--only` takes seconds.
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
- **A counterexample for a PROTOCOL drives the production composition, not the helper.** A test that builds
  its own deps bag proves the helper behaves when wired; it cannot see that production has no parameter to
  wire it through. `VerifierPassDeps.attempts` was optional, the composition root had no argument for it, and
  the correction was a no-op in every real dispatch while its test passed (arch-review 64). Where the root is
  too large to construct, assert the CONSTRUCTOR SIGNATURE carries the dependency — a fixture cannot pass what
  production cannot.
- **A guard the in-memory twin does not have is a guard no unit test can see.** `PARENT_AUTHORIZES` is a SQL
  join; the in-memory attempt store has no parent table, so every counterexample for recovery adoption passed
  while the production store refused every one of those writes (arch-review 66 P0). When a protocol's decision
  lives in the ADAPTER — a join, a constraint, a conditional UPDATE's WHERE clause — its counterexample is a
  `*.trust.test.ts` against real Postgres, and the in-memory test proves only the shape.
- **A twin that ignores an argument the real store filters on is a guard no unit test can see — and TENANT
  is the argument this happens to.** `InMemoryEvolutionCampaignStore`'s campaign half scoped every read by
  workspace ("another workspace's row reads as nonexistent"); its adoption half took `_tenant` on all four
  methods and ignored it, while the Postgres twin filters on it. So the in-memory store was more permissive
  than production on the one axis where that is worst, and no fixture could see it because no fixture ever
  passed a second workspace (arch-review 74). When a method takes an argument it does not use, the
  underscore is the tell: either the twin is wrong, or the parameter is. Add the second-workspace case —
  the one that asserts the OTHER tenant is answered nothing — beside the ordinary one.
- **A DOUBLE THAT PERFORMS A WRITE AND REPORTS THAT IT DID NOT IS THE SAME LIE, INVERTED.** Seven fake
  `SqlClient`s pushed the row for an `INSERT … RETURNING 1` and answered `{ rows: [] }`. Harmless for as long
  as nothing read the answer — and the moment a store started deciding on it, every one of those tests said
  "the statement matched nothing". The always-succeeds double returns the success value it cannot have
  earned; this one withholds evidence of a write it DID perform. Both are a double that does not answer the
  way the real one would (arch-review 119). If the statement has a `RETURNING`, the double returns a row.
- **An `_` prefix on a parameter is a claim that deserves a second reading.** `InMemoryRuntimeRegistry` took
  `_teamId` and passed `undefined` under a comment saying the table has no such column; migration 0106 gave
  it one and the Pg twin was corrected, while this sibling kept the old body under the old justification. Every
  unit assertion about a runtime's owning team was green against a store that could not hold one. When a
  method ignores an argument its twin honours, either the twin is wrong or the parameter is — and the comment
  explaining why is the thing most likely to be out of date.
- **A parity test compares the two PRODUCTION entry points.** The durability file compared
  `recoverStagedVerdict` against `recoverVerifiedCase` — two helpers, both missing what the real normal path
  (`withVerifierPass`) adds — so a field present on one path and absent on the other stayed green. Parity is
  asserted between what production actually runs, not between two functions that happen to be nearby.
- **A fixture whose ids all match is not the production shape.** A scorecard child's `id` is a random row id
  and its `executionId` is a different string; a test that sets them equal cannot see a lookup using the
  wrong one, which is how a recovery that finds no handles at all stayed green (arch-review 63 P0).
