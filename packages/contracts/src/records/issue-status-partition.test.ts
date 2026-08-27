import { describe, expect, it } from "vitest";
import { CLOSED_ISSUE_STATUSES, ISSUE_STATUSES, OPEN_ISSUE_STATUSES } from "./tracker.js";

// ── "OPEN" IS DECIDED ONCE (arch-review 110) ───────────────────────────────────────────────────────────
//
// Four call sites had each written the same filter — the release store, the product service, the initiative
// service and the workspace pulse — while `@everdict/domain` already exported `isOpenIssueStatus` and this file
// already exported the closed half. They had not diverged; L3's point is that a predicate written five times is
// in the state a duplicated predicate is in BEFORE it diverges, and the bill arrives the day one copy learns
// something the others do not. arch-review 106 made `inTriage` reachable and immediately raised such a
// question — does a queued request count as open work — which with five copies would have been five answers.
//
// What this pins is the PARTITION, not the membership list: open and closed cover the vocabulary exactly once
// between them, so a status added tomorrow lands in exactly one and cannot land in neither. A membership
// assertion would have to be edited by the same change that adds the status, which is how a guard becomes a
// formality; this one cannot be satisfied by editing it.
describe("the issue status vocabulary is partitioned exactly once", () => {
  it("every status is either open or closed, and none is both", () => {
    for (const status of ISSUE_STATUSES) {
      const open = OPEN_ISSUE_STATUSES.includes(status);
      const closed = CLOSED_ISSUE_STATUSES.includes(status);
      expect(open === closed, `${status} is in ${open ? "both" : "neither"} half of the vocabulary`).toBe(false);
    }
    expect(OPEN_ISSUE_STATUSES.length + CLOSED_ISSUE_STATUSES.length).toBe(ISSUE_STATUSES.length);
  });

  // The one membership fact worth stating outright, because it is the one a reader gets wrong: a resolution
  // that stopped holding is unfinished work, so `regressed` blocks a goal exactly like an unstarted issue.
  it("keeps `regressed` open — a resolution that stopped holding is work in flight", () => {
    expect(OPEN_ISSUE_STATUSES).toContain("regressed");
    expect(CLOSED_ISSUE_STATUSES).toEqual(expect.arrayContaining(["done", "cancelled"]));
  });
});
