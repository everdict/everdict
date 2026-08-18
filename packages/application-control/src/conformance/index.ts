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
  // Claim an operation, let the clock run past the lease, RENEW it, then ask the sweep whether the row is
  // available. Answers how many operations the sweep would take (arch-review 55, Wave 8).
  owedAfterRenewalPastLease: () => Promise<number>;
  // The same clock, and a renewal attempted by somebody who is NOT the holder. Answers whether the store
  // accepted it — a renewal that can revive or steal a claim is a second way to take the row.
  renewalByAnotherOwner: () => Promise<boolean>;
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

    // ── THE LEASE IS EXTENDABLE, AND ONLY BY ITS HOLDER (arch-review 55, Wave 8) ──────────────────
    //
    // The drain heartbeats while the sink call is in flight, because an export carrying a whole batch's
    // traces routinely outruns a lease sized for "a publisher's process died". An implementation whose
    // renewal does not move the sweep's view of the row leaves that defect exactly where it was.
    it("a renewed claim is not swept, however long the drain takes", async () => {
      expect(
        await world().owedAfterRenewalPastLease(),
        "the sweep could take an operation whose publisher is still working on it",
      ).toBe(0);
    });

    it("only the holder may renew — a renewal is not a second way to take the row", async () => {
      expect(await world().renewalByAnotherOwner(), "a non-holder extended somebody else's claim").toBe(false);
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
