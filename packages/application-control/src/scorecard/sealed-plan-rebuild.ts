import type { Dataset, HarnessSpec, ScorecardRecord } from "@everdict/contracts";
import { applyGradingPlan, selectSubsetCases } from "@everdict/domain";
import { resolveCaseEnvironments } from "../environment/case-environment.js";
import { ExecutionPlan } from "./execution-plan.js";
import type { ScorecardBatchDeps } from "./scorecard-deps.js";
import { embedHarnessSpec } from "./scorecard-plan.js";

// ── RE-RUNNING A CASE MEANS RE-RUNNING **THAT** EXPERIMENT ───────────────────────────────────────────
//
// Five sealed facets have to be restored before a single case is dispatched again, and every one of them
// has a way to go silently wrong by resolving TODAY's registry instead of the batch's:
//
//   the dataset documents  — the resolved bundle at the version the record names, narrowed by its subset
//   the grading plan       — the run-time graders the submit recorded, re-applied to those cases
//   the environments       — re-resolved at the versions the manifest sealed, never at `latest`
//   the harness closure    — the spec as it was, with the batch's own pin overrides
//   the model bindings     — pinned through the plan, so a moved `latest` cannot change what executes
//
// A retry that re-resolved any of them would measure a DIFFERENT world under an unchanged manifest, which is
// worse than refusing: every digest in the record would still agree with itself.
//
// This lived inside `RetryFailedBatch.run` and is now shared with the in-place retry pass
// (docs/architecture/in-place-case-retry-spec.md). It is extracted rather than copied deliberately — a
// five-facet restoration written twice has already diverged (protocol L3), and the half that would rot is
// the one whose author was thinking about something else.
export interface SealedPlanRebuild {
  plan: ExecutionPlan;
  dataset: Dataset;
  harnessSpec?: HarnessSpec;
}

export async function rebuildSealedPlan(
  deps: ScorecardBatchDeps,
  tenant: string,
  record: ScorecardRecord,
): Promise<SealedPlanRebuild> {
  const plan = ExecutionPlan.of(record);
  const resolved = await deps.datasets.get(tenant, record.dataset.id, record.dataset.version);
  const { cases } = selectSubsetCases(
    resolved,
    record.subset ? { ids: record.subset.ids, tags: record.subset.tags, limit: record.subset.limit } : undefined,
  );
  // Re-apply the recorded grading plan — a re-run must score exactly like the original submit.
  const graded = applyGradingPlan(cases, record.orchestration?.graders);
  const environments = await resolveCaseEnvironments({
    tenant,
    cases: graded,
    ...(deps.environments ? { registry: deps.environments } : {}),
    ...(plan.sealedEnvironments ? { sealed: plan.sealedEnvironments } : {}),
  });
  const dataset: Dataset = { ...resolved, cases: environments.cases };

  let harnessSpec: HarnessSpec | undefined;
  const pins = record.origin?.pinOverrides;
  if (deps.harnesses) {
    const harnesses = deps.harnesses;
    // Registered → embed the resolved spec; unregistered/built-in (NotFound) → no spec embedded (as at
    // submit); a registered-but-invalid spec fails loudly rather than re-dispatching a malformed job.
    harnessSpec = plan.pinSpec(
      await embedHarnessSpec(
        () =>
          pins && Object.keys(pins).length > 0
            ? harnesses.resolveWithPins(tenant, record.harness.id, record.harness.version, pins)
            : harnesses.get(tenant, record.harness.id, record.harness.version),
        { id: record.harness.id, version: record.harness.version },
      ),
    );
  }
  return { plan, dataset, ...(harnessSpec ? { harnessSpec } : {}) };
}
