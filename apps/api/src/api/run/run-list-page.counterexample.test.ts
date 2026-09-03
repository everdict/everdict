import { describe, expect, it } from "vitest";
import { DEFAULT_RUN_PAGE, MAX_RUN_PAGE, runActivityPage } from "./request/run-page.js";

// ── THE ACTIVITY LIST HAS A PAGE SIZE, AND BOTH TRANSPORTS USE THE SAME ONE (perf review) ───────────
//
// `RunStore.list`'s `limit` is "ABSENT = every match" on purpose — boot recovery and the reapers want that.
// Both run-list transports passed no limit when the caller named none, so the default answer to "show me
// this workspace's runs" was every standalone run it had ever executed, as `SELECT *` (the `result` jsonb
// carries snapshots, diffs and whole traces), serialized synchronously in a shared process.
//
// Two properties, and the second is why this lives in its own module rather than in either transport:
//   a page has a SIZE by default          — an absent limit is a page, never "everything"
//   the two transports share the OWNER    — they resolved this identically, which is how they came to be
//                                           unbounded identically
//
// SEEN RED by neutralizing `runActivityPage` to the pre-fix resolution (`return limit === undefined ? {} :
// { limit }`), observed:
//   AssertionError: an absent limit must still be a page: expected undefined to be 200

describe("the run activity list is a page", () => {
  it("gives an absent limit a page size rather than the whole ledger", () => {
    // Given: a caller that named no limit — the default for every UI and every API client
    const page = runActivityPage(undefined);

    // Then: it is a page. `{}` here means "every run this workspace ever executed".
    expect(page.limit, "an absent limit must still be a page").toBe(DEFAULT_RUN_PAGE);
  });

  it("refuses to let a caller widen the page past the ceiling", () => {
    // Given: a caller asking for far more than the ceiling
    // Then: the ceiling holds — a bound a caller can raise by asking is not a bound
    expect(runActivityPage(1_000_000).limit).toBe(MAX_RUN_PAGE);
    expect(runActivityPage(MAX_RUN_PAGE + 1).limit).toBe(MAX_RUN_PAGE);
  });

  it("honours a smaller page, and treats nonsense as unset", () => {
    // Given: a legitimate smaller page
    expect(runActivityPage(25).limit).toBe(25);
    // …and values that are not a page at all fall back to the default rather than to unbounded
    expect(runActivityPage(0).limit).toBe(DEFAULT_RUN_PAGE);
    expect(runActivityPage(-5).limit).toBe(DEFAULT_RUN_PAGE);
    expect(runActivityPage(Number.NaN).limit).toBe(DEFAULT_RUN_PAGE);
    expect(runActivityPage(Number.POSITIVE_INFINITY).limit).toBe(DEFAULT_RUN_PAGE);
  });
});
