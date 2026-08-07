import type { OpsReport, Scorecard, ScorecardRecord } from "@everdict/contracts";
import { scorecardOutcomes } from "./case-outcome.js";
import { evidenceStatus } from "./evidence-status.js";

// Workspace ops report (metrics commercialization C1) — one pure derivation over the workspace's OWN
// scorecard ledger: how much of the window's failure is the PLATFORM's (infra/scoring/evidence) versus the
// product's. The SSOT for the numbers the SLA conversation stands on — the web, MCP and any credit math read
// THIS, never re-derive.
//
// Honesty rules (trust kernel): a rate whose denominator is zero is ABSENT, never 0 — a window with no
// executed cases has no infra-failure rate. Batches without per-case detail (list rows, pre-offload records)
// contribute to the batch tallies but not to case/evidence sums — partial visibility is reported as smaller
// denominators, never invented rows.
export type OpsReportInput = Pick<ScorecardRecord, "status" | "requested"> & {
  scorecard?: Pick<Scorecard, "results">;
};

export function workspaceOpsReport(records: OpsReportInput[], window?: { from?: string; to?: string }): OpsReport {
  const batches = { total: records.length, succeeded: 0, failed: 0, cancelled: 0, superseded: 0 };
  const cases = {
    executed: 0,
    gradeable: 0,
    verdicted: 0,
    passed: 0,
    failed: 0,
    infraFailed: 0,
    cancelled: 0,
    unmeasured: 0,
  };
  let requested: number | undefined;
  const trace = { complete: 0, partial: 0, missing: 0, deferred: 0 };
  const snapshot = { complete: 0, missing: 0 };
  for (const record of records) {
    if (record.status === "succeeded") batches.succeeded++;
    else if (record.status === "failed") batches.failed++;
    else if (record.status === "cancelled") batches.cancelled++;
    else if (record.status === "superseded") batches.superseded++;
    if (record.requested !== undefined) requested = (requested ?? 0) + record.requested;
    if (!record.scorecard) continue;
    const o = scorecardOutcomes(record.scorecard);
    cases.executed += o.executed;
    cases.gradeable += o.gradeable;
    cases.verdicted += o.verdicted;
    cases.passed += o.passed;
    cases.failed += o.failed;
    cases.infraFailed += o.infraFailed;
    cases.cancelled += o.cancelled;
    cases.unmeasured += o.unmeasured;
    for (const result of record.scorecard.results) {
      const e = evidenceStatus(result);
      trace[e.trace]++;
      snapshot[e.snapshot]++;
    }
  }
  return {
    ...(window?.from !== undefined ? { from: window.from } : {}),
    ...(window?.to !== undefined ? { to: window.to } : {}),
    batches,
    cases: { ...cases, ...(requested !== undefined ? { requested } : {}) },
    rates: {
      ...(cases.executed > 0 ? { infraFailure: cases.infraFailed / cases.executed } : {}),
      ...(cases.gradeable > 0 ? { unmeasured: cases.unmeasured / cases.gradeable } : {}),
      ...(cases.executed > 0 ? { traceComplete: trace.complete / cases.executed } : {}),
    },
    evidence: { trace, snapshot },
  };
}
