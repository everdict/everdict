---
name: testing
description: How Everdict tests — Vitest only, English BDD descriptions, in-memory stores + fake Dispatcher for units, buildServer+inject for the API surface, fake SqlClient for Postgres logic, env-gated *.scenario.test.ts for live E2E. Use when writing or editing tests (Vitest unit + scenario E2E).
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
---
# Testing (Vitest test idioms)

One tool: **Vitest**. `pnpm test` = `turbo run test` (per-package `vitest run`, `dependsOn ^build`). Cover
business logic + permissions + edge/validation; skip trivial CRUD and framework behavior. Every `fix:` ships a
regression test that FAILS on the pre-fix code. `apps/web` has no `test` script (self-contained eslint/prettier)
so it's excluded from the root run — never add web unit tests here.

## Checklist
1. File suffix: `*.test.ts` = unit/integration; `*.scenario.test.ts` = live E2E over real infra.
2. `it("a user can submit their own suite", …)` — **English BDD**, Given/When/Then (comment the phases).
3. Unit: `InMemory*` stores + inject a fake `Dispatcher`/dep; assert one behavior, no live I/O, no network.
4. Cover permission gates (401/403/404/409/402) and error/edge paths; another workspace's resource reads **404**.
5. Live E2E: `describe.skipIf(!env)` so CI stays green; boot the real thing via a shared factory, not ad-hoc wiring.

## Reference impl
`apps/api/src/run-service.test.ts` — the canonical unit test: a file-local `okDispatcher`/`failDispatcher`
(satisfying `Dispatcher`) + capture dispatchers, `InMemoryRunStore`, injected `newId`/`budget`, and a
`flush()` (`setTimeout 0`) to await the async submit. Assert status transitions + the exact job/side-effect.

## Unit tests — inject fakes at the interface
Depend on the interface, hand it a fake. Patterns to copy:
- **`Dispatcher`**: `{ async dispatch(job) { … } }` — `run-service.test.ts`; a bare `dispatch` fn for
  `runSuite` in `packages/suite/src/suite.test.ts` (per-case isolation: one throw must not sink the batch).
- **`Backend`**: a class implementing `capacity()`+`dispatch()` — `ControlledBackend` in
  `packages/backends/src/scheduler.test.ts` (hand-resolved promises observe concurrency/fairness) + `BackendRegistry`
  + `inMemoryBudget`.
- **Stub deps** via constructor opts (`newId`, `budget`, `meterUsageFor`, `secretsFor`, `fetch`) — never reach for
  real clocks/ids/network. Use `vi.spyOn` to assert a collaborator was (not) called.

## API surface (integration) — buildServer + inject
Boot the whole Fastify app through the file-local `server()` factory in `apps/api/src/server.test.ts`: it wires
every `InMemory*` store + registry + a stub authenticator, calls `buildServer({…})`, and drives it with
`app.inject({ method, url, headers, payload })` (light-my-request, no socket). This factory IS the shared boot
helper — do not hand-wire routes ad-hoc. Auth is stubbed two ways: `roleAuth(["viewer"])` returns a fixed
`Principal` (authZ tests), or `issueKey(keyStore, "acme")` mints a real `ak_…` (auth-core tests). Assert
`res.statusCode` + `res.json()`; always `await app.close()`. For async endpoints poll (`pollScorecard`).

## Postgres — fake SqlClient, not a live DB
Pg store logic is unit-tested against a fake `SqlClient` (`fakeClient` in
`packages/db/src/scorecard-store.test.ts` / `db.test.ts`): assert the parameterized SQL text + params
(`INSERT INTO everdict_scorecards`, `$1`, `ORDER BY created_at DESC, id DESC`) and the row→record mapping. Behavior
is covered against `InMemory*` in the same file — the two impls must stay interchangeable. **No Testcontainers**;
real-Postgres verification is an env-gated live script (`scripts/live/pg-run-store.mjs`, boots via `DATABASE_URL`
+ `migrate()`), not a CI test.

## MCP — test both layers
`apps/api/src/mcp.test.ts`: pair an in-memory `Client`↔server over `InMemoryTransport`
(`@modelcontextprotocol/sdk`) bound to a `Principal` to exercise tool logic, role gating, workspace scoping, and
the tool inventory (`listTools`). The transport-level `401` + `WWW-Authenticate: resource_metadata=…` challenge
and `/.well-known/oauth-protected-resource` are tested via Fastify `inject` in `server.test.ts` (a new capability
= one service core, two transports — test the tool AND the challenge).

## Live / E2E
`*.scenario.test.ts` hits real infra behind `describe.skipIf(!BASE || !KEY || !MODEL)` so it no-ops without env
(`packages/graders/src/model-judge.scenario.test.ts` — real OpenAI-compatible/LiteLLM). Full loops against
Nomad/K8s/MLflow/Temporal/Postgres live in `scripts/live/*.mjs`, run by hand, not in `turbo test`.

See rule `testing.md` for the pushed critical rules; the vitest config is `packages/core/vitest.config.ts`
(`include: src/**/*.test.ts`).
