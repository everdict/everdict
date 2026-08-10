import type { EvalCase, HarnessSpec, ScorecardManifest } from "@everdict/contracts";
import { contentDigest } from "../provenance/content-digest.js";

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
  subject: "dataset_case" | "grading" | "harness";
  // The case id, or the harness ref — what moved.
  id: string;
  sealed: string;
  current: string;
}

// Compare the documents a re-resolution just produced against what the manifest sealed.
//
// PER CASE, not over a composite: a batch re-plans a SUBSET of its cases (resume runs only the unfinished
// ones), so a whole-bundle digest could not be compared at all without re-deriving the exact selection. The
// per-case seals were introduced for the orthogonal identity axes and answer this question directly.
//
// A manifest with no `cases` map predates the split seal (identityVersion absent/legacy) — there is nothing
// to verify against, and inventing a comparison would report drift that the seal never claimed to exclude.
export function verifySealedExecution(
  manifest: ScorecardManifest | undefined,
  actual: {
    // The cases this execution is about to run, AFTER subset selection and BEFORE the grading plan is applied
    // (the plan is a batch-level document, sealed as `grading`, and applying it would mask a default-grader
    // change on the case itself).
    cases?: ReadonlyArray<Pick<EvalCase, "id" | "graders">>;
    // The resolved harness spec, BEFORE `pinHarnessSpecToClosure` rewrites its bindings — the manifest sealed
    // the registry document, and the pin is applied on top of it at dispatch.
    harnessSpec?: HarnessSpec | undefined;
    harnessRef?: string;
  },
): SealedDocumentMismatch[] {
  if (manifest === undefined) return [];
  const mismatches: SealedDocumentMismatch[] = [];
  const sealedCases = manifest.cases;
  const sealedGrading = manifest.gradingCases;
  for (const c of actual.cases ?? []) {
    // The SEMANTIC case digest strips `graders` — the case contract calls that field a runtime-replaced
    // default, so it is sealed on its own axis (below) and hashing it here would make a grading change read
    // as a content change.
    const sealed = sealedCases?.[c.id];
    if (sealed !== undefined) {
      const current = contentDigest({ ...c, graders: undefined });
      if (current !== sealed) mismatches.push({ subject: "dataset_case", id: c.id, sealed, current });
    }
    // …and the DEFAULT GRADERS, on their own axis. A shadow that changes only what a case is graded by would
    // otherwise pass the content check while changing what "passed" means. Present only on defaults runs — a
    // run-time grading plan is a batch document that no registry lookup can move.
    const sealedGraders = sealedGrading?.[c.id];
    if (sealedGraders !== undefined) {
      const current = contentDigest(c.graders);
      if (current !== sealedGraders) mismatches.push({ subject: "grading", id: c.id, sealed: sealedGraders, current });
    }
  }
  const sealedSpec = manifest.harness.specDigest;
  if (sealedSpec !== undefined && actual.harnessSpec !== undefined) {
    const current = contentDigest(actual.harnessSpec);
    if (current !== sealedSpec)
      mismatches.push({
        subject: "harness",
        id: actual.harnessRef ?? `${manifest.harness.id}@${manifest.harness.version}`,
        sealed: sealedSpec,
        current,
      });
  }
  return mismatches;
}

// The one sentence an operator needs: which documents moved under a held name, and what to do about it.
export function sealedExecutionMessage(mismatches: readonly SealedDocumentMismatch[]): string {
  const named = mismatches
    .slice(0, 5)
    .map((m) => `${m.subject}:${m.id}`)
    .join(", ");
  const more = mismatches.length > 5 ? ` (+${mismatches.length - 5} more)` : "";
  return `the documents this batch sealed are no longer what '${named}'${more} resolves to — a registry entry with the same id and version now returns different content (a workspace-local version shadowing a shared one does exactly this). Refusing to execute a document this batch did not certify; remove the shadowing version or submit a new batch.`;
}
