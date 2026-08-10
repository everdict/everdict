import type { HarnessSpec, ProductSeries } from "@everdict/contracts";
import {
  type ResolvedSeriesContract,
  type SeriesContractResolution,
  contentDigest,
  resolveRef,
  seriesContractDigest,
} from "@everdict/domain";
import type { HarnessInstanceRegistry } from "../ports/harness-instance-registry.js";
import type { JudgeRegistry } from "../ports/judge-registry.js";
import type { ScorecardServiceDeps } from "../scorecard/scorecard-deps.js";
import { resolveModelPin, sealHarnessModelClosure, sealJudgeClosure } from "../scorecard/scorecard-plan.js";

// WHAT A WATCH SERIES ASKS TODAY — resolved ONCE, for both readers (arch-review 15 P1-5).
//
// There were two answers to "what is this evaluation's identity". The scorecard manifest sealed one at submit
// (sealHarnessModelClosure + sealJudgeClosure); the product gate hand-rolled a second one beside it. Being
// hand-rolled, the second was a SUBSET: no `serviceModels` (a service-topology harness's per-service bindings
// are exactly the moving refs this exists to catch), no delegated harness for a harness-judge (the judge's
// whole agent could be swapped with the contract reading held), no spec digest. So a release could ship
// against a "held" contract that the manifest — looking at the same registries a moment earlier — already knew
// had moved. Two answers to one question is the defect; a weaker second answer is the defect plus a false
// assurance.
//
// The seam is not "resolution vs resolution", it is ONE RESOLUTION and TWO POLICIES over the hole:
//
//   manifest   records a fact about an execution that HAPPENED — a hole is recorded honestly ("unresolved")
//              and the batch still runs, because refusing to record would lose the run entirely.
//   gate       asks whether the current question's identity is ESTABLISHED — a hole is not an answer, so any
//              "unresolved" sentinel (or an unreadable spec) makes the whole contract `unresolvable`.
//
// This module is the policy; the sealers stay the resolution. A new closure facet therefore reaches the
// release gate the moment it reaches the manifest, which is the only arrangement in which the two cannot
// drift apart again.

// The registries are REQUIRED here, unlike on the batch deps where a built-in harness or a judge-less batch
// makes them optional. A gate that cannot read the registries cannot state the question, so "not wired" is
// not a degraded mode this caller has — it is a deployment that must not resolve contracts at all.
export type SeriesContractDeps = Pick<
  ScorecardServiceDeps,
  "datasets" | "rubrics" | "resolveModelBinding" | "judgeFor" | "models"
> & {
  harnesses: HarnessInstanceRegistry;
  judges: JudgeRegistry;
};

// A registry ref resolves to a CONCRETE version, or to the reason it could not. Every failure answers with
// its reason — never `undefined`, which used to travel to "skip the freshness check" and let stale evidence
// pass a release (arch-review 14 P0).
async function concreteRef(
  registry: { versions(tenant: string, id: string): Promise<string[]> },
  kind: string,
  tenant: string,
  ref: { id: string; version?: string },
): Promise<{ id: string; version: string } | string> {
  try {
    const versions = await registry.versions(tenant, ref.id);
    if (versions.length === 0) return `${kind} '${ref.id}' has no versions in this workspace`;
    return { id: ref.id, version: resolveRef(ref.id, ref.version ?? "latest", versions) };
  } catch (err) {
    return `${kind} '${ref.id}' could not be resolved: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function resolveSeriesContract(
  deps: SeriesContractDeps,
  tenant: string,
  series: ProductSeries,
): Promise<SeriesContractResolution> {
  const dataset = await concreteRef(deps.datasets, "dataset", tenant, series.dataset);
  if (typeof dataset === "string") return { status: "unresolvable", reason: dataset };
  const harness = await concreteRef(deps.harnesses, "harness", tenant, series.harness);
  if (typeof harness === "string") return { status: "unresolvable", reason: harness };
  const judges: Array<{ id: string; version: string }> = [];
  for (const judge of series.judges) {
    const resolved = await concreteRef(deps.judges, "judge", tenant, judge);
    if (typeof resolved === "string") return { status: "unresolvable", reason: resolved };
    judges.push(resolved);
  }

  // THE DATASET'S BYTES (arch-review 16 P0-2). `support@1` is a NAME, and the registry resolves it owner-first
  // over a `_shared` fallback — so a workspace registering its own `support@1` substitutes a different
  // document, with every case's task, environment, timeout and default graders free to differ, while the id
  // and the version string both read held. Digested with the same function the manifest uses.
  let datasetDigest: string;
  try {
    datasetDigest = contentDigest((await deps.datasets.get(tenant, dataset.id, dataset.version)).cases);
  } catch (err) {
    return {
      status: "unresolvable",
      reason: `dataset '${dataset.id}@${dataset.version}' could not be read: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  // The TREATMENT's closure. Reading the spec is itself part of the question: a harness whose document cannot
  // be read has no identity to state, which is a different sentence from "it has no model binding". Its BYTES
  // travel too, for the same shadowing reason as the dataset — and because two harness documents can differ
  // in script, environment or service topology while their model closures coincide exactly.
  let spec: HarnessSpec;
  try {
    spec = await deps.harnesses.get(tenant, harness.id, harness.version);
  } catch (err) {
    return {
      status: "unresolvable",
      reason: `harness '${harness.id}@${harness.version}' could not be read: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  const harnessClosure = await sealHarnessModelClosure(deps, tenant, spec);
  if (harnessClosure.model === "unresolved")
    return {
      status: "unresolvable",
      reason: `harness '${harness.id}@${harness.version}' names a model binding that could not be resolved`,
    };
  for (const [service, model] of Object.entries(harnessClosure.serviceModels ?? {}))
    if (model === "unresolved")
      return {
        status: "unresolvable",
        reason: `harness '${harness.id}@${harness.version}' service '${service}' names a model binding that could not be resolved`,
      };

  // …and the JUDGES' closure, from the same sealer the manifest uses. `specDigest` absent means the sealer
  // could not read the document at all (it catches per judge so one bad spec never fails a batch) — for the
  // gate that IS the unresolvable case, since the version was resolved a moment ago and should therefore read.
  const judgeClosure = await sealJudgeClosure(deps, tenant, judges);
  for (const sealed of judgeClosure) {
    const at = `judge '${sealed.id}@${sealed.version}'`;
    if (sealed.specDigest === undefined) return { status: "unresolvable", reason: `${at} could not be read` };
    if (sealed.model === "unresolved")
      return { status: "unresolvable", reason: `${at} names a model binding that could not be resolved` };
    if (sealed.rubric === "unresolved")
      return { status: "unresolvable", reason: `${at} names a rubric that could not be resolved` };
    if (sealed.harness === "unresolved")
      return { status: "unresolvable", reason: `${at} delegates to a harness that could not be resolved` };
  }

  // The RUNTIME judge configuration, sealed exactly the way submit seals it (a series names no override, so
  // this is the workspace default). The manifest has carried this facet since the batch's own identity was
  // widened and the gate had not caught up — a workspace switching its default judge model changes what every
  // inline judge grader means, with every id/version in the series declaration reading held.
  //
  // No `judgeFor` wired = this deployment has no workspace default to resolve, which is the same fact a
  // submit from the same deployment would seal. Both sides agree, so the facet is honestly absent rather than
  // a hole.
  let judgeRun: { provider?: string; model: string } | undefined;
  let judgeRunModelDigest: string | undefined;
  if (deps.judgeFor !== undefined) {
    const judge = await deps.judgeFor(tenant);
    if (judge !== undefined) {
      // The ref AND its document, from the sealer submit uses (arch-review 21 P0-1). A gate that compared the
      // ref alone said `model-x@1` is identity while the bytes behind it are not, which is the shadow every
      // other facet of this contract exists to catch.
      const pin = await resolveModelPin(deps, tenant, judge.model);
      if (pin.ref === "unresolved" || pin.unreadable === true)
        return {
          status: "unresolvable",
          reason: "the workspace's default judge model binding could not be resolved",
        };
      judgeRun = { ...(judge.provider !== undefined ? { provider: judge.provider } : {}), model: pin.ref };
      judgeRunModelDigest = pin.digest;
    }
  }
  const contract: ResolvedSeriesContract = {
    dataset: { ...dataset, digest: datasetDigest },
    harness: { ...harness, specDigest: contentDigest(spec) },
    judges,
    ...(harnessClosure.model !== undefined ? { harnessModel: harnessClosure.model } : {}),
    ...(harnessClosure.serviceModels !== undefined ? { serviceModels: harnessClosure.serviceModels } : {}),
    // …and the model DOCUMENTS (arch-review 19 P0-4): a ref cannot distinguish a `_shared` model from a
    // workspace-local one wearing its name, so a release gate comparing refs alone would read a swapped model
    // as held. Sealed by the same function the manifest uses, so the two stay one vocabulary.
    ...(harnessClosure.modelDigest !== undefined ? { harnessModelDigest: harnessClosure.modelDigest } : {}),
    ...(harnessClosure.serviceModelDigests !== undefined
      ? { serviceModelDigests: harnessClosure.serviceModelDigests }
      : {}),
    judgeClosure,
    ...(judgeRun !== undefined ? { judgeRun } : {}),
    ...(judgeRunModelDigest !== undefined ? { judgeRunModelDigest } : {}),
  };
  return { status: "resolved", digest: seriesContractDigest(contract), contract };
}
