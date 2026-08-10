import type { CaseResult, PlacementOs } from "@everdict/contracts";
import { contentDigest } from "../provenance/content-digest.js";

// THE WORLD A BATCH RAN IN — an axis of COMPARISON, never of identity (arch-review 19 P2).
//
// The evaluation contract seals what is being ASKED: dataset, harness closure, judge closure. Where it ran is
// a different question, and folding it into the contract would be the classic too-broad guard — every
// infrastructure move would invalidate a product's whole evidence base, and a signal that cries wolf on
// migrations is one people learn to route around. That decision is recorded in
// `docs/architecture/product-timeline.md` and this does not change it.
//
// What was missing is the other half. With no world axis at all, two runs of the same contract on different
// operating systems, drivers or images land on one trend line as though they answered the same question under
// the same conditions — so a regression caused by a migration reads as a regression caused by the change. The
// honest handling is to STRATIFY: compare within a cohort, and when a comparison crosses one, say so.
//
// Derived from what the cases already reported (`CaseResult.execution`, the manifest the execution site writes
// about itself) rather than from anything new. A case that ran in no world at all — a dispatch that died, an
// ingested trace — contributes nothing, and a batch where nothing reported a world has NO cohort. Absence is
// "not recorded", never "linux": that is the same rule the per-case manifest already lives by, and inventing
// a default here would undo it one level up.

export interface WorldCohort {
  // Present only when every case that reported a world agrees. A batch spread over two operating systems is
  // not "linux with exceptions" — it is a batch whose world is MIXED, which is a fact a comparison must see.
  os?: PlacementOs;
  drivers?: string[]; // Driver.id / TopologyRuntime.id — sorted, deduped
  images?: string[];
  // True when the reporting cases did not agree on the os. A mixed batch is comparable to nothing cleanly,
  // and saying so is more useful than picking a majority.
  mixed: boolean;
  // How many cases reported a world at all — the denominator for "is this cohort well-observed".
  observed: number;
}

const uniqueSorted = (values: Array<string | undefined>): string[] =>
  [...new Set(values.filter((v): v is string => v !== undefined && v !== ""))].sort();

export function worldCohortOf(results: readonly CaseResult[]): WorldCohort | undefined {
  const manifests = results
    .map((r) => r.execution)
    .filter((m): m is NonNullable<CaseResult["execution"]> => m !== undefined);
  if (manifests.length === 0) return undefined; // nothing ran in a world we recorded — no cohort to claim
  const oses = [...new Set(manifests.map((m) => m.os))];
  const drivers = uniqueSorted(manifests.flatMap((m) => [m.driver, m.runtime]));
  const images = uniqueSorted(manifests.map((m) => m.image));
  const single = oses.length === 1 ? oses[0] : undefined;
  return {
    ...(single !== undefined ? { os: single } : {}),
    ...(drivers.length > 0 ? { drivers } : {}),
    ...(images.length > 0 ? { images } : {}),
    mixed: oses.length > 1,
    observed: manifests.length,
  };
}

// The cohort's comparison key. Two batches with the same digest ran under conditions we have no reason to
// believe differ; two with different digests are a CROSS-COHORT comparison, which is a weaker claim than a
// within-cohort one and must be labelled as such rather than silently averaged.
export function worldCohortDigest(cohort: WorldCohort | undefined): string | undefined {
  if (cohort === undefined) return undefined;
  return contentDigest({
    ...(cohort.os !== undefined ? { os: cohort.os } : {}),
    ...(cohort.drivers !== undefined ? { drivers: cohort.drivers } : {}),
    ...(cohort.images !== undefined ? { images: cohort.images } : {}),
    mixed: cohort.mixed,
  });
}

// Why a comparison across two cohorts cannot be attributed to the change alone. Returns undefined when the
// two sides are the same world, or when either side never recorded one — an unknown world is not a known
// difference, and reporting it as one would make every legacy comparison look suspect.
export function crossWorldReason(
  baseline: WorldCohort | undefined,
  candidate: WorldCohort | undefined,
): string | undefined {
  const a = worldCohortDigest(baseline);
  const b = worldCohortDigest(candidate);
  if (a === undefined || b === undefined || a === b) return undefined;
  const describe = (c: WorldCohort): string =>
    c.mixed ? "several worlds" : [c.os, ...(c.drivers ?? [])].filter(Boolean).join("/") || "an unnamed world";
  return `these two evaluations ran in different execution worlds (${describe(baseline as WorldCohort)} → ${describe(
    candidate as WorldCohort,
  )}) — a difference between them cannot be attributed to the change alone; re-run the baseline in the candidate's world to compare within one`;
}
