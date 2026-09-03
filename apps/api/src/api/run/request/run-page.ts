import type { RunListOptions } from "@everdict/application-control";

// ── THE ACTIVITY LIST IS A PAGE, AND IT HAD NO PAGE SIZE (perf review) ──────────────────────────────
//
// caller named no limit — and the store's `limit` is deliberately "ABSENT = every match", because internal
// readers (boot recovery, the reapers, the usage meter) want exactly that. So the DEFAULT answer to "show me
// this workspace's runs" was every standalone run it had ever executed, projected as `SELECT *`, which
// carries the `result` jsonb: snapshots, diffs, whole traces. One request, growing forever, serialized
// synchronously into one JSON string in a process every workspace shares.
//
// The ceiling belongs to the TRANSPORT rather than to the store, for the reason the store's own comment
// gives: an unbounded internal reader is a legitimate caller, and moving the default down there would change
// what recovery sees. What a PERSON asked for is a page.
//
// Written once and imported by both transports — BFF and MCP resolved this identically, which is also how
// they came to be unbounded identically (rule `protocol` L3: a predicate written twice has already diverged).
// 200 is a feed depth, not a guess at what fits: the activity console renders newest-first, and a reader
// scrolling past two hundred executions is navigating rather than scanning. It is a BEHAVIOUR CHANGE for a
// caller that passed no limit — `apps/web` is one — and the change is the point: those callers were
// receiving the workspace's entire execution history, and the screen was unusable long before the endpoint
// was. A caller that needs more says so, up to the ceiling; a caller that needs ALL of them is an internal
// reader and does not come through here.
export const DEFAULT_RUN_PAGE = 200;
export const MAX_RUN_PAGE = 500;

// ⚠️ THE BATCH DRILL-DOWN IS DELIBERATELY NOT PAGED HERE. `?scorecardId=` feeds `canonicalCaseRuns` /
// `serveBatchChildren`, which decide which attempt is a case's answer by looking at the batch's children AS A
// SET — a partial page would label rows `canonical` against evidence it could not see. That read is bounded
// by one batch's case count rather than by the workspace's history, so it is a different question; giving it
// a page needs the canonical resolution to move into the store, not a `limit` here.
export function runActivityPage(limit: number | undefined): Pick<RunListOptions, "limit"> {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return { limit: DEFAULT_RUN_PAGE };
  return { limit: Math.min(Math.floor(limit), MAX_RUN_PAGE) };
}
