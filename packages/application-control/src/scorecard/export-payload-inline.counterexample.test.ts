import type { CaseResult } from "@everdict/contracts";
import { readExportPayload } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { stageAnalysis } from "./scorecard-observability.js";

// ── A DURABLE OPERATION HOLDS THE BYTES IT OWES (arch-review 57 P1) ──────────────────────────────────
//
// A settlement plans an export and the drain performs it later. Between those two moments the record's
// results can move — an ordinary re-score — so the operation cannot mean "whatever the record holds when the
// sweep gets to it". arch-review 54 froze the bytes under an immutable key; arch-review 55 made the failure
// to freeze SAY so instead of looking like a legacy row.
//
// What neither did is make the operation own its bytes when there is no object store. `{kind: "unfrozen"}`
// is still a plannable outcome, and an operation in that state is one whose bytes nobody holds: the drain can
// only re-read the record and compare, so it converges exactly until anything re-scores and then fails
// permanently. "A durable operation exists" is not "the operation durably holds what it must publish", and an
// install with no S3/MinIO — the ordinary self-hosted shape — plans nothing else.
//
// So the third state is not a weaker freeze, it is a different HOME for the same bytes: inline on the
// operation itself. The rule the review states, in order —
//
//   object store available → immutable key + digest
//   not available         → the payload travels ON the operation, compressed
//   neither possible      → REFUSE to plan the publication
//
// — and `unfrozen` survives only for READING rows that predate this (mig 0188's backfill).
//
// RED as of 6f62fb9c, observed:
//   expected { kind: 'unfrozen', reason: 'no artifact store is wired here — nothing can be frozen' }
//   to match object { kind: 'inline' }

const results = (n: number): CaseResult[] =>
  Array.from({ length: n }, (_, i) => ({
    caseId: `c${i}`,
    harness: "h",
    trace: [],
    scores: [],
    snapshot: { kind: "prompt" as const, output: "" },
  })) as CaseResult[];

const bundle = { cases: [] } as never;

describe("[R57 COUNTEREXAMPLE] a settlement with no object store still owns the bytes it will publish", () => {
  it("carries the payload INLINE when no artifact store is wired", async () => {
    const staged = await stageAnalysis({ artifacts: undefined }, "sc-1", bundle, "pass-1", results(3));
    expect(staged.payload, "an operation was planned whose bytes nobody holds").toMatchObject({ kind: "inline" });
  });

  it("carries it inline when the store is there but the PUT fails", async () => {
    // An object-store blip during a settle is not a reason to plan an unverifiable export.
    const artifacts = {
      async put() {
        throw new Error("503 from the object store");
      },
      async get() {
        return undefined;
      },
    };
    const staged = await stageAnalysis({ artifacts } as never, "sc-1", bundle, "pass-1", results(3));
    expect(staged.payload).toMatchObject({ kind: "inline" });
  });

  it("round-trips: what goes inline comes back byte-identical", async () => {
    const original = results(5);
    const staged = await stageAnalysis({ artifacts: undefined }, "sc-1", bundle, "pass-1", original);
    expect(staged.payload?.kind).toBe("inline");
    if (staged.payload?.kind !== "inline") return;
    expect(readExportPayload(staged.payload)).toEqual(original);
  });

  it("REFUSES to plan when the payload is too large to travel on the operation", async () => {
    // The third arm of the rule. An operation row is not an object store, so beyond a bound the honest answer
    // is that this deployment cannot publish this settlement — said at PLAN time, where it is actionable,
    // rather than at drain time where the batch has already been recorded as pending export.
    await expect(stageAnalysis({ artifacts: undefined }, "sc-1", bundle, "pass-1", results(200_000))).rejects.toThrow(
      /too large|cannot be published|no artifact store/i,
    );
  });

  it("stages a key, not bytes, when the store works — inline is the fallback, not the default", async () => {
    const put: string[] = [];
    const artifacts = {
      async put(key: string) {
        put.push(key);
        return `ref:${key}`;
      },
      async get() {
        return undefined;
      },
    };
    const staged = await stageAnalysis({ artifacts } as never, "sc-1", bundle, "pass-1", results(3));
    expect(staged.payload).toMatchObject({ kind: "frozen" });
    expect(put.length).toBeGreaterThan(0);
  });

  it("stages nothing extra for a caller that owes no export", async () => {
    const staged = await stageAnalysis({ artifacts: undefined }, "sc-1", bundle, "pass-1");
    expect(staged.payload).toBeUndefined();
  });
});
