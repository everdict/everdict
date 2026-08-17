import { describe, expect, it } from "vitest";

// ── THE CONTROL-PLANE PROTOCOL SUITES (arch-review 53, Wave F) ──────────────────────────────────────
//
// A conformance suite is a FUNCTION OVER AN IMPLEMENTATION: adding one means running the suite, and changing
// a protocol means changing the suite once rather than remembering every adapter that implements it. These
// two live here rather than beside the backend suites because the ports they certify are this package's, and
// `@everdict/backends` depends on this package — a suite over there would be a reverse edge.

// ── PublicationOperationConformance — one settlement, one operation (Wave C) ────────────────────────
export interface PublicationOperationWorld {
  // Drain the same operation twice, concurrently. Answers how many times the SINK was called.
  drainTwice: () => Promise<number>;
  // Open two settlements' operations, then list what the ledger owes for that scorecard.
  owedAfterTwoSettlements: () => Promise<string[]>;
}

export function describePublicationOperation(name: string, world: () => PublicationOperationWorld): void {
  describe(`${name} — publication operation conformance`, () => {
    it("two concurrent drains produce one external effect", async () => {
      expect(await world().drainTwice(), "both publishers reached the sink").toBe(1);
    });

    it("a second settlement adds a debt rather than replacing one", async () => {
      const owed = await world().owedAfterTwoSettlements();
      expect(owed.length, "a re-score erased the previous settlement's export debt").toBe(2);
    });
  });
}

// ── CancellationVerificationConformance — completion is a verified state (Wave E) ───────────────────
export interface CancellationVerificationWorld {
  // Run a teardown whose readback found live work. Answers the operation's state afterwards.
  afterLiveReadback: () => Promise<string>;
  // Run a teardown whose readback saw zero. Answers the operation's state afterwards.
  afterQuietReadback: () => Promise<string>;
}

export function describeCancellationVerification(name: string, world: () => CancellationVerificationWorld): void {
  describe(`${name} — cancellation verification conformance`, () => {
    it("a readback that found live work leaves the operation owed", async () => {
      const state = await world().afterLiveReadback();
      expect(state === "verifying" || state === "requested", `completed over live work (state ${state})`).toBe(true);
    });

    it("only a readback that saw zero completes the operation", async () => {
      expect(await world().afterQuietReadback()).toBe("completed");
    });
  });
}
