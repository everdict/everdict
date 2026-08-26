import { defineConfig } from "vitest/config";

// ── THIS PACKAGE'S SUITES ARE ORDERING-SENSITIVE, AND ORDERING COSTS TIME (arch-review 71) ───────────
//
// The same symptom `job-runner` states one package over, arriving differently: identical runs of this suite
// produced 0, 1, 4, 6 and 12 failures, and every one of those files passed repeatedly on its own. Reverting
// the change under test did not settle it, so it is not a defect in the code being edited — it is the suite
// meeting the 5s default while every package's tests run at once.
//
// Why it surfaces as ASSERTION failures rather than timeouts, which is what made it hard to read: these
// suites drive settlement paths that await a store, a fence and a stamp in sequence. A step that loses its
// budget mid-chain leaves the ledger half-advanced, and the assertion that follows reports the state it
// found — `expected 'reserved' to be 'committed'` — which looks exactly like a logic bug and is not one.
//
// 30s is the same budget `job-runner` chose for the same reason. Stating it per package says what these
// tests actually cost instead of inheriting a default written for pure functions.
//
// ⚠️ THIS IS A SIGNAL FIX, NOT AN EXPLANATION. What is certain: sequential runs are deterministic (1063
// passed, repeatedly) and the instability predates the changes that exposed it. What is NOT established is
// the mechanism — whether the budget alone accounts for every one of those failures, or whether some file
// pair genuinely shares state. A suite whose red/green is decided by machine load cannot report a real
// regression, so the budget is raised first; the mechanism is worth its own investigation.
export default defineConfig({
  test: { testTimeout: 30_000, hookTimeout: 30_000 },
});
