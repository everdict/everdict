import { defineConfig } from "vitest/config";

// ── A ROUTE TEST BUILDS A SERVER, AND 5s IS A STATEMENT ABOUT THE MACHINE ────────────────────────────
//
// 48 files here construct a Fastify app with the full route surface inside their `it()`, and that is the
// PATTERN rather than an oversight: each case needs a differently-wired server (a different principal, a
// different team ceiling, a feature deliberately left unwired), so hoisting the build into `beforeAll` would
// mean asserting one wiring per file.
//
// Vitest's default per-test budget is 5s, which is enough on an idle box — the two slowest of these run in
// about a second alone — and not enough under `pnpm ci:commits`, which runs every package's suite at once.
// Two DIFFERENT route files have now failed that way (`cycle-visibility.routes.test.ts`,
// `issue.routes.test.ts`), each on a run where nothing near them had changed.
//
// The failure mode is what makes this worth a config file rather than a shrug: a timeout is reported as
// `Test timed out in 5000ms`, which reads as "this code hangs" and sends the next person to the route. The
// number was never about the route; it was about how loaded the machine is.
//
// 30s is ~25× the observed cost of the slowest case, so a genuine deadlock still fails fast, and the suite
// stops depending on what else is running.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
