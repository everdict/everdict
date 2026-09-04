import type { CaseCommitReceipt, RunRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryCaseReceiptStore, executionPassAuthority } from "./case-receipt-store.js";
import type { RunStore } from "./run-store.js";

// ── A NEW DECISION MAY REPLACE THE POINTER; NOTHING MAY EDIT ONE ─────────────────────────────────────
//
// `resultsFromLedger` makes the receipt authoritative for a settled plane — it rebuilds `results` from
// `receipt.childRunId` and DROPS anything no receipt vouches for. So an in-place retry that produces no
// receipt is not merely unrecorded: its result is discarded at the next settle and the batch keeps the
// answer the retry was repairing.
//
// The store is still not CRUD. What these certify is the narrow act the retry needs: under an authority
// minted from a LIVE execution pass, a committed case's pointer moves and the decision it displaced comes
// back whole, for the caller to preserve on the attempt ledger.

const receipt = (childRunId: string, digest: string): CaseCommitReceipt => ({
  scorecardId: "sc-1",
  caseId: "c1",
  trial: 0,
  childRunId,
  resultDigest: digest,
  committedAt: "2026-09-04T00:00:00.000Z",
});

const settles = (id: string) => async (): Promise<RunRecord | undefined> => ({ id }) as RunRecord;
const runs = {} as RunStore;

const claimed = (over: Record<string, unknown> = {}) => ({
  id: "sc-1",
  executionPass: { passId: "p-1", targetRevision: 1, status: "running", ...over },
});

describe("executionPassAuthority — the mint is the check", () => {
  it("mints from a record whose live marker IS the pass being claimed for", () => {
    expect(executionPassAuthority(claimed(), "p-1")).toBeDefined();
  });

  it("refuses when the record carries no marker at all", () => {
    // A caller holding a record it read BEFORE the claim cannot produce an authority — which is the whole
    // point of taking the claimed record rather than a caller-built object.
    expect(executionPassAuthority({ id: "sc-1" }, "p-1")).toBeUndefined();
  });

  it("refuses when the marker names a DIFFERENT pass — a rival claimed in between", () => {
    expect(executionPassAuthority(claimed({ passId: "p-2" }), "p-1")).toBeUndefined();
  });

  it("refuses a marker that is no longer running — identity is not authority", () => {
    expect(executionPassAuthority(claimed({ status: "failed" }), "p-1")).toBeUndefined();
  });
});

describe("commitCase — the supersession arm", () => {
  it("WITHOUT an authority a committed case is untouched, exactly as before", async () => {
    const store = new InMemoryCaseReceiptStore();
    expect((await store.commitCase(receipt("run-1", "dig-1"), settles("run-1"), runs)).kind).toBe("committed");
    const second = await store.commitCase(receipt("run-2", "dig-2"), settles("run-2"), runs);
    expect(second.kind).toBe("already_committed");
    // …and the pointer did not move. This is the assertion that matters: `already_committed` naming the
    // NEW child would be the edit this design refuses, reported as a refusal.
    expect(second.kind === "already_committed" && second.receipt.childRunId).toBe("run-1");
    expect((await store.list("sc-1"))[0]?.childRunId).toBe("run-1");
  });

  it("WITH an authority the pointer moves and the displaced decision comes back whole", async () => {
    const store = new InMemoryCaseReceiptStore();
    await store.commitCase(receipt("run-1", "dig-1"), settles("run-1"), runs);
    const authority = executionPassAuthority(claimed(), "p-1");
    const out = await store.commitCase(
      receipt("run-2", "dig-2"),
      settles("run-2"),
      runs,
      undefined,
      undefined,
      authority,
    );
    expect(out.kind).toBe("superseded");
    if (out.kind !== "superseded") throw new Error(out.kind);
    expect(out.receipt.childRunId).toBe("run-2");
    // The displaced receipt is the ONLY copy of the decision this commit replaced — dropping it here would
    // make the supersession an edit after all, with the evidence gone.
    expect(out.displaced.childRunId).toBe("run-1");
    expect(out.displaced.resultDigest).toBe("dig-1");
    expect((await store.list("sc-1"))[0]?.childRunId).toBe("run-2");
  });

  it("refuses an authority minted for ANOTHER record — a pass owns one batch", async () => {
    const store = new InMemoryCaseReceiptStore();
    await store.commitCase(receipt("run-1", "dig-1"), settles("run-1"), runs);
    const foreign = executionPassAuthority({ ...claimed(), id: "sc-other" }, "p-1");
    const out = await store.commitCase(
      receipt("run-2", "dig-2"),
      settles("run-2"),
      runs,
      undefined,
      undefined,
      foreign,
    );
    // Nothing else in this store would notice a pass on batch A moving batch B's pointers.
    expect(out.kind).toBe("already_committed");
    expect((await store.list("sc-1"))[0]?.childRunId).toBe("run-1");
  });

  it("an authority on a case that never committed is an ordinary commit, not a supersession", async () => {
    // A retry may legitimately name a case the original batch never got to. There is no displaced decision,
    // and reporting one would put an entry on the attempt ledger that answers a question nobody asked.
    const store = new InMemoryCaseReceiptStore();
    const out = await store.commitCase(
      receipt("run-1", "dig-1"),
      settles("run-1"),
      runs,
      undefined,
      undefined,
      executionPassAuthority(claimed(), "p-1"),
    );
    expect(out.kind).toBe("committed");
  });

  it("a REFUSED settle moves nothing — the claim rolls back with it", async () => {
    const store = new InMemoryCaseReceiptStore();
    await store.commitCase(receipt("run-1", "dig-1"), settles("run-1"), runs);
    const out = await store.commitCase(
      receipt("run-2", "dig-2"),
      async () => undefined, // the child's fence said no
      runs,
      undefined,
      undefined,
      executionPassAuthority(claimed(), "p-1"),
    );
    expect(out.kind).toBe("unsettled");
    // The pointer must still be the original. A supersession that moved it over a settle nobody accepted
    // would leave the plane naming a child that never became terminal.
    expect((await store.list("sc-1"))[0]?.childRunId).toBe("run-1");
  });
});
