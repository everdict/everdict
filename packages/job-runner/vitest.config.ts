import { defineConfig } from "vitest/config";

// ── THIS PACKAGE'S TESTS SPAWN REAL PROCESSES ────────────────────────────────────────────────────────
//
// Vitest's 5s default was written for pure functions. The suites here seed git repositories, run harnesses
// through a driver, diff trees and grade them — real filesystem and subprocess work, comfortable in 5s when
// a file runs alone and not when every package's suites run at once, which is how CI runs them.
//
// The symptom is a family, not a case: three separate files timed out in the commit gate while passing
// repeatedly on their own, and each fix by hand left the rest. Stating the budget once, per package, says
// what these tests actually cost instead of inheriting a default meant for cheaper ones.
export default defineConfig({
  test: { testTimeout: 30_000, hookTimeout: 30_000 },
});
