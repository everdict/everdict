import { type ScorecardRecord, TRACE_EVAL_REF } from "@everdict/contracts";
import { HarvestBuilder, type HarvestResult } from "./harvest.js";

// The extractor tag stamped on every mention/edge this harvester emits — the version axis. Bumping it (v1 → v2) makes
// a re-harvest append a fresh, distinguishable generation of rows rather than colliding with the old ones.
export const SCORECARD_HARVESTER = "scorecard_harvester_v1";

// Project a ScorecardRecord into the knowledge graph. A scorecard is the densest foreign-key hub in everdict — one
// record wires together the harness under test, the dataset, the judges, the runtime, the schedule that fired it, the
// user who ran it, the metrics it measured, and its retry lineage. This is the first (reference) structured harvester;
// others follow the same HarvestBuilder shape. Pure and deterministic.
export function harvestScorecard(sc: ScorecardRecord): HarvestResult {
  const label =
    sc.dataset.id === TRACE_EVAL_REF
      ? "trace evaluation"
      : `${sc.dataset.id}@${sc.dataset.version} × ${sc.harness.id}@${sc.harness.version}`;

  const b = new HarvestBuilder(sc.tenant, "scorecard", sc.id, SCORECARD_HARVESTER, sc.updatedAt, sc.createdAt).self(
    { type: "scorecard", key: sc.id },
    label,
    { status: sc.status },
  );

  // Every node lives in a workspace — materialise the hub edge so a workspace can enumerate its graph.
  b.ref("in_workspace", { type: "workspace", key: sc.tenant }, "tenant");

  if (sc.createdBy !== undefined && sc.createdBy !== "") {
    b.ref("created_by", { type: "user", key: sc.createdBy }, "createdBy");
  }
  // The eval subject + data — absent for the "evaluate existing traces" path (a sentinel dataset/harness id).
  if (sc.harness.id !== TRACE_EVAL_REF) {
    b.ref("evaluates", { type: "harness", key: sc.harness.id, version: sc.harness.version }, "harness");
  }
  if (sc.dataset.id !== TRACE_EVAL_REF) {
    b.ref("uses_dataset", { type: "dataset", key: sc.dataset.id, version: sc.dataset.version }, "dataset");
  }
  sc.orchestration?.judges.forEach((j, i) => {
    b.ref("applies_judge", { type: "judge", key: j.id, version: j.version }, `orchestration.judges[${i}]`);
  });
  if (sc.runtime !== undefined && sc.runtime !== "") {
    b.ref("runs_on", { type: "runtime", key: sc.runtime }, "runtime");
  }
  if (sc.origin?.scheduleId !== undefined && sc.origin.scheduleId !== "") {
    b.ref("fired_by", { type: "schedule", key: sc.origin.scheduleId }, "origin.scheduleId");
  }
  if (sc.origin?.retryOf !== undefined && sc.origin.retryOf !== "") {
    b.ref("derived_from", { type: "scorecard", key: sc.origin.retryOf }, "origin.retryOf");
  }
  // The metrics this batch measured — the summary carries the aggregate value onto the edge for at-a-glance querying.
  (sc.summary ?? []).forEach((m, i) => {
    // mean is ABSENT for an annihilated metric (count 0) — never write a fabricated 0 onto the edge; the
    // unmeasured tally rides along so the graph can see the outage instead of dropping it.
    const attrs: Record<string, unknown> = { count: m.count };
    if (m.mean !== undefined) attrs.mean = m.mean;
    if (m.passRate !== undefined) attrs.passRate = m.passRate;
    if (m.unmeasured !== undefined) attrs.unmeasured = m.unmeasured;
    b.ref("measures", { type: "metric", key: m.metric }, `summary[${i}]`, attrs);
  });

  return b.result();
}
