import { describe, expect, it } from "vitest";
import { analysisBundle, initialPassId } from "./scorecard-observability.js";

// Certified in the trust suite (docs/trust-certification.md) as:
//   TRUST-165 — An artifact is keyed by the attempt that made it, never by the thing it is about
// Named here because the table's last column points at this file, and a row whose test does not say
// which claim it carries leaves the next reader to guess which assertion is load-bearing.
// ── A COMPETING FINALIZER CANNOT OVERWRITE THE WINNER'S BUNDLE (review 39 P0-6) ──────────────────────
describe("initialPassId — the initial pass is keyed by its own bytes", () => {
  // The bundle is the JUDGMENT, so what distinguishes two finalizers is what they concluded — here, one
  // holding a scored case and one that got there with the case still unscored.
  const bundleOf = (value: number) =>
    analysisBundle({ scorecardId: "sc-1", dataset: "d@1", harness: "h@1" }, [] as never, [
      {
        caseId: "c1",
        harness: "h@1",
        trace: [],
        scores: [{ graderId: "g", metric: "pass", value }],
        snapshot: { kind: "prompt" as const, output: "" },
      },
    ]);

  it("two finalizers holding different results write different keys — neither replaces the other", () => {
    // A Temporal activity is at-least-once and an in-process driver can race a recovery; both freeze a bundle
    // BEFORE the ledger decides which of them settles. Under the old literal `initial` they wrote one object,
    // so the ledger could name a revision whose artifact described a pass that never happened.
    expect(initialPassId(bundleOf(1))).not.toBe(initialPassId(bundleOf(0)));
    expect(initialPassId(bundleOf(1))).toMatch(/^initial-[0-9a-f]{16}$/);
  });

  it("…and identical bundles share one object, because they are the same evidence", () => {
    expect(initialPassId(bundleOf(1))).toBe(initialPassId(bundleOf(1)));
  });
});
