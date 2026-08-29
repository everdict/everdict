import { describe, expect, it } from "vitest";
import { runRetentionSweep } from "./retention-sweep.js";

// ── [R120 COUNTEREXAMPLE] AN OUTAGE IS NOT "NOTHING WAS OLD ENOUGH" ─────────────────────────────────
//
// The two retention sweeps in the composition root read `.catch(() => 0)`, and their `if (removed > 0)`
// then made the zero silent. So an object-store or database outage was observationally identical to a quiet
// hour, every hour, forever — and the trajectory sweep is the one that now THROWS on an object-store
// refusal on purpose, so that the rows naming the payload objects survive for the next pass. Swallowing
// that throw converts the fail-closed design straight back into the silent orphan it was written to stop.
//
// Seen RED before the fix: "an outage was reported as a clean sweep: expected 'swept' to be 'failed'".
describe("[R120 COUNTEREXAMPLE] a retention sweep says which of the two things happened", () => {
  it("answers `failed` when the store refused — never a successful zero", async () => {
    const outcome = await runRetentionSweep("2026-01-01T00:00:00.000Z", async () => {
      throw new Error("object storage delete failed: connection refused");
    });
    expect(outcome.kind, "an outage was reported as a clean sweep").toBe("failed");
    // The reason travels, because an operator's next action depends on it.
    expect(outcome.kind === "failed" ? outcome.reason : "").toContain("connection refused");
  });

  it("answers `swept` with 0 when the store genuinely removed nothing — the two must stay apart", async () => {
    const outcome = await runRetentionSweep("2026-01-01T00:00:00.000Z", async () => 0);
    expect(outcome.kind, "a quiet hour was reported as a failure").toBe("swept");
    expect(outcome.kind === "swept" ? outcome.removed : -1).toBe(0);
  });

  it("passes the cutoff through and reports what was removed", async () => {
    const seen: string[] = [];
    const outcome = await runRetentionSweep("2026-03-01T00:00:00.000Z", async (cutoff) => {
      seen.push(cutoff);
      return 7;
    });
    expect(seen, "the cutoff never reached the store").toEqual(["2026-03-01T00:00:00.000Z"]);
    expect(outcome.kind === "swept" ? outcome.removed : -1).toBe(7);
  });
});
