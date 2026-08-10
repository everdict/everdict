import type { EvalCase, HarnessSpec, ScorecardManifest } from "@everdict/contracts";
import { contentDigest, digestsMatch } from "../provenance/content-digest.js";

// THE DOCUMENT A BATCH RE-READS MUST BE THE DOCUMENT IT SEALED (arch-review 17 P0-1).
//
// A registry version is immutable — inside ONE namespace. Lookup is owner-first with a `_shared` fallback, so
// the effective identity of `support@1` has a hidden third coordinate: which namespace answered. A workspace
// that registers its own `support@1` after a batch was submitted shadows the `_shared` document the manifest
// certified, and every path that re-reads by (tenant, id, version) then gets DIFFERENT BYTES under the same
// name:
//
//   T1 submit          _shared/support@1 = A, _shared/agent@1 = A   → manifest seals A, A
//   T2 tenant registers  tenant/support@1 = B, tenant/agent@1 = B
//   T3 Temporal plan / resume / re-score
//                      get(tenant, "support", "1") → B
//                      get(tenant, "agent",   "1") → B
//   T4 execution runs B while the manifest certifies A
//
// Resume is worse than a plain reproducibility loss: completed cases are kept and only the unfinished ones
// re-run, so ONE scorecard can hold cases evaluated under A beside cases evaluated under B — two experiments
// inside one revision, certified as one.
//
// The seals to compare against already exist; nothing was verifying them. This is that verification, and it
// is deliberately a REFUSAL rather than a re-seal: a batch cannot decide mid-flight that it is now measuring
// something else. The operator's fix is to remove the shadow or submit a new batch, both of which leave the
// evidence honest.
//
// Namespace-qualified pins (`CapabilityPin{owner, id, version, digest}`) would let a re-read TARGET the right
// document instead of detecting that it got the wrong one, and that is the better end state. Verification is
// what makes the current one safe, and it stays useful afterwards: it is the check that a pin was honoured.

export interface SealedDocumentMismatch {
  subject: "dataset_case" | "grading" | "harness" | "selection";
  // The case id, the harness ref, or — for `selection` — the case that appeared or vanished.
  id: string;
  sealed: string;
  current: string;
}

// The per-case comparisons both callers share. The SEMANTIC case digest strips `graders` — the case contract
// calls that field a runtime-replaced default, so it is sealed on its own axis and hashing it here would make
// a grading change read as a content change.
function caseMismatches(
  manifest: ScorecardManifest,
  cases: ReadonlyArray<Pick<EvalCase, "id" | "graders">>,
): SealedDocumentMismatch[] {
  const out: SealedDocumentMismatch[] = [];
  for (const c of cases) {
    const sealed = manifest.cases?.[c.id];
    if (sealed !== undefined) {
      // ALGORITHM-NEUTRAL (arch-review 21 P1). Stamps written before sha256 are FNV, and a raw
      // `contentDigest(doc) !== stamped` comparison calls every one of them drift — so a batch sealed in that
      // era would refuse to resume, re-score or re-verify against ITS OWN unchanged documents, and report a
      // registry shadow as the reason. `digestsMatch` re-hashes under the stamp's own algorithm, which is the
      // policy `content-digest.ts` already states and only one reader was following.
      if (!digestsMatch(sealed, { ...c, graders: undefined }))
        out.push({ subject: "dataset_case", id: c.id, sealed, current: contentDigest({ ...c, graders: undefined }) });
    }
    // …and the DEFAULT GRADERS, on their own axis. A shadow that changes only what a case is graded by would
    // otherwise pass the content check while changing what "passed" means. Present only on defaults runs — a
    // run-time grading plan is a batch document no registry lookup can move.
    const sealedGraders = manifest.gradingCases?.[c.id];
    if (sealedGraders !== undefined && !digestsMatch(sealedGraders, c.graders))
      out.push({ subject: "grading", id: c.id, sealed: sealedGraders, current: contentDigest(c.graders) });
  }
  return out;
}

function harnessMismatch(
  manifest: ScorecardManifest,
  spec: HarnessSpec | undefined,
  ref: string | undefined,
): SealedDocumentMismatch[] {
  const sealed = manifest.harness.specDigest;
  if (sealed === undefined || spec === undefined) return [];
  if (digestsMatch(sealed, spec)) return [];
  const current = contentDigest(spec);
  return [{ subject: "harness", id: ref ?? `${manifest.harness.id}@${manifest.harness.version}`, sealed, current }];
}

// THE BATCH PATHS — Temporal's plan and the in-process resume, which re-resolve the whole selection.
//
// EXACT SET, not "the members that survived" (arch-review 18 P0-3). The first version walked the ACTUAL cases
// and compared any that the manifest also had, so a shadow that ADDED a case slipped through (nothing to
// compare it to) and one that REMOVED a case slipped through too (the loop never met it). Either way the
// batch would run a different selection than the manifest certifies — with the record's `requested` count
// still describing the old one. The sealed selection is part of the document, not merely the bytes of the
// members that happen to still be there.
//
// A manifest with no `cases` map predates the split seal — nothing to verify against, and inventing a
// comparison would report drift the seal never claimed to exclude.
export function verifySealedSelection(
  manifest: ScorecardManifest | undefined,
  actual: {
    // AFTER subset selection and BEFORE the grading plan is applied (the plan is a batch-level document, and
    // applying it first would mask a default-grader change on the case itself).
    cases: ReadonlyArray<Pick<EvalCase, "id" | "graders">>;
    // BEFORE `pinHarnessSpecToClosure` rewrites its bindings — the manifest sealed the registry document, and
    // the pin is applied on top of it.
    harnessSpec?: HarnessSpec | undefined;
    harnessRef?: string;
  },
): SealedDocumentMismatch[] {
  if (manifest === undefined) return [];
  const mismatches = [
    ...caseMismatches(manifest, actual.cases),
    ...harnessMismatch(manifest, actual.harnessSpec, actual.harnessRef),
  ];
  const sealedIds = manifest.cases === undefined ? undefined : new Set(Object.keys(manifest.cases));
  if (sealedIds !== undefined) {
    const actualIds = new Set(actual.cases.map((c) => c.id));
    for (const id of actualIds)
      if (!sealedIds.has(id)) mismatches.push({ subject: "selection", id, sealed: "absent", current: "present" });
    for (const id of sealedIds)
      if (!actualIds.has(id)) mismatches.push({ subject: "selection", id, sealed: "present", current: "absent" });
  }
  return mismatches;
}

// THE RE-SCORE PATH, whose question is different: a detached pass judges the cases that already have RESULTS,
// so the current dataset may legitimately be larger. What it may not be is missing one of them.
//
// The hole this closes (arch-review 18 P0-3): the check filtered the resolved dataset down to the judged case
// ids, so a case the shadow DELETED simply never appeared — verification passed, the shadowed dataset was
// returned, and the judge stream then skipped that case for having no `EvalCase`. By then the pass had already
// stripped the selected judges' rows, so the case ended the pass with its verdict removed and nothing written
// in its place: a silent deletion of evidence, produced by a check that was looking straight at it.
export function verifySealedCaseDocuments(
  manifest: ScorecardManifest | undefined,
  judgedCaseIds: readonly string[],
  resolved: ReadonlyArray<Pick<EvalCase, "id" | "graders">>,
): SealedDocumentMismatch[] {
  if (manifest === undefined) return [];
  const byId = new Map(resolved.map((c) => [c.id, c]));
  const mismatches: SealedDocumentMismatch[] = [];
  for (const id of judgedCaseIds) {
    if (manifest.cases !== undefined && manifest.cases[id] === undefined)
      // A result whose case the manifest never sealed cannot be re-judged against anything.
      mismatches.push({ subject: "selection", id, sealed: "absent", current: "present" });
    else if (!byId.has(id)) mismatches.push({ subject: "selection", id, sealed: "present", current: "absent" });
  }
  return [
    ...mismatches,
    ...caseMismatches(
      manifest,
      resolved.filter((c) => judgedCaseIds.includes(c.id)),
    ),
  ];
}

// The one sentence an operator needs: which documents moved under a held name, and what to do about it.
export function sealedExecutionMessage(mismatches: readonly SealedDocumentMismatch[]): string {
  const named = mismatches
    .slice(0, 5)
    .map((m) => `${m.subject}:${m.id}`)
    .join(", ");
  const more = mismatches.length > 5 ? ` (+${mismatches.length - 5} more)` : "";
  return `the documents this batch sealed are no longer what '${named}'${more} resolves to — a registry entry with the same id and version now returns different content, or the selection itself changed (a workspace-local version shadowing a shared one does exactly this). Refusing to execute a document this batch did not certify; remove the shadowing version or submit a new batch.`;
}

// A NESTED CAPABILITY DOCUMENT, verified against the digest its pin sealed (arch-review 19 P0-4).
//
// The top-level documents (dataset, harness, judge) each got this check as their own defect was found. Their
// DEPENDENCIES did not, and they are the same shape one level in: a judge's model, its rubric, its delegated
// harness, and a harness's per-service models are all `{ref}` bindings resolved through the same owner-first
// lookup. `model-x@1` names whichever namespace answers, and the model document carries the provider, the
// underlying model, the base URL and the key secret — everything that decides what the model IS lives in the
// document, none of it in the ref. A ref-only pin therefore cannot detect a shadow at all: the string it
// compares is identical on both sides.
//
// Four resolution points read these at execution (the judge concretizer, the judge transport's auth lookup,
// the judge runner's model read, the harness dispatcher's binding resolution) and every one of them calls
// this. That is the point of it being a function rather than four checks: this area's last three defects were
// all one path verifying what another did not.
//
// `undefined` sealed digest = the document could not be read when the pin was made. Absence is "never
// pinned", never agreement — the caller keeps going, exactly as it did before pins existed, because refusing
// on it would strand every batch sealed before this generation.
export function pinnedDocumentMismatch(
  sealedDigest: string | undefined,
  document: unknown,
  what: { kind: string; ref: string },
): string | undefined {
  if (sealedDigest === undefined) return undefined;
  // Compared under the STAMP's own algorithm — a pin written before sha256 must keep verifying against its
  // own document (arch-review 21 P1), or the migration itself becomes an invisible shadow that refuses every
  // legacy evaluation with a message blaming the registry.
  if (digestsMatch(sealedDigest, document)) return undefined;
  const current = contentDigest(document);
  return `the ${what.kind} '${what.ref}' this evaluation pinned is not what that reference resolves to now (sealed ${sealedDigest}, current ${current}) — a workspace-local version shadowing a shared one does exactly this, and the reference alone cannot tell them apart`;
}
