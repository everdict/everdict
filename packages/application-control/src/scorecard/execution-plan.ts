import type { CaseJob, EvalCase, HarnessSpec, ScorecardManifest, ScorecardRecord } from "@everdict/contracts";
import { ConflictError } from "@everdict/contracts";
import { sealedExecutionMessage, verifySealedSelection } from "@everdict/domain";
import { pinHarnessSpecToClosure } from "./scorecard-plan.js";
import type { SealedJudgeEntry } from "./scorecard-plan.js";

// THE PLAN A BATCH EXECUTES UNDER — resolved once at submit, CONSUMED by every later path (arch-review 21).
//
// Submit seals an identity: which dataset documents, which harness document, which model documents beneath
// it, which judge closure, which verdict policy. Every path that later executes or re-executes that batch —
// the Temporal plan, the in-process resume, a re-score — then RECONSTRUCTED that identity by hand: read the
// manifest, pull out the facets it happened to know about, verify the ones it happened to check, carry the
// ones it happened to carry. Two paths, two hand-copies of one artifact.
//
// The failure mode is not hypothetical; it is the last four waves of this review series. A sealed facet was
// verified on the resume path and not on the Temporal path (18 P0-2). The model document pins reached the
// Temporal job and not the in-process one (20 P0-2). The harness model digests reached the series contract
// type and not its digest (21 P0-1). Each was a field that existed and one consumer that had not been taught
// about it, and each was found by a reviewer rather than by a compiler.
//
// So the facets live HERE, behind methods, and a consumer asks the plan instead of reading the manifest.
// Adding a sealed facet is then one edit in one object, and the paths cannot drift because there is nothing
// left for them to copy. This is deliberately NOT a new document: the manifest is still the artifact, still
// the thing stamped on the record and re-derivable forever. This is the one reader of it.
export class ExecutionPlan {
  private constructor(
    private readonly manifest: ScorecardManifest | undefined,
    private readonly ref: { scorecardId: string; harness: string },
  ) {}

  // A record's plan. A record with no manifest predates sealing — the plan then verifies nothing and carries
  // nothing, which is the same honest degradation each call site implemented separately.
  static of(record: Pick<ScorecardRecord, "id" | "manifest" | "harness">): ExecutionPlan {
    return new ExecutionPlan(record.manifest, {
      scorecardId: record.id,
      harness: `${record.harness.id}@${record.harness.version}`,
    });
  }

  // ── What an executor must CHECK ───────────────────────────────────────────────────────────────────────
  // The re-read documents must be the ones this batch sealed. Refusal, never re-seal: a batch cannot decide
  // mid-flight that it is now measuring something else.

  // The dataset half — the EXACT selection plus each case's content and default grading.
  assertSelection(cases: ReadonlyArray<Pick<EvalCase, "id" | "graders">>): void {
    this.refuse(verifySealedSelection(this.manifest, { cases }));
  }

  // The harness half. Filtered to `harness` because an empty case list would otherwise read as "every case
  // was removed" — the two halves are checked at different moments by both callers.
  assertHarness(spec: HarnessSpec | undefined): void {
    if (spec === undefined) return;
    this.refuse(
      verifySealedSelection(this.manifest, { cases: [], harnessSpec: spec, harnessRef: this.ref.harness }).filter(
        (m) => m.subject === "harness",
      ),
    );
  }

  private refuse(mismatches: ReturnType<typeof verifySealedSelection>): void {
    if (mismatches.length > 0)
      throw new ConflictError("CONFLICT", { scorecard: this.ref.scorecardId }, sealedExecutionMessage(mismatches));
  }

  // ── What an executor must CARRY ───────────────────────────────────────────────────────────────────────

  // The spec with its moving `{ref}` bindings rewritten to the closure the manifest sealed — the seal IS the
  // pin, so dispatch executes the submit-time resolution instead of re-resolving `latest` per case.
  pinSpec(spec: HarnessSpec | undefined): HarnessSpec | undefined {
    return pinHarnessSpecToClosure(spec, this.manifest?.harness);
  }

  // The model DOCUMENTS this batch pinned, in the shape the job carries. The dispatcher is where a `{ref}`
  // finally becomes a provider, a base URL and a key, and it has no other way to know what was certified.
  get modelPins(): CaseJob["modelPins"] {
    const harness = this.manifest?.harness;
    if (harness === undefined) return undefined;
    const pins = {
      ...(harness.modelDigest !== undefined ? { model: harness.modelDigest } : {}),
      ...(harness.serviceModelDigests !== undefined ? { serviceModels: harness.serviceModelDigests } : {}),
      ...(this.manifest?.judgeRunModelDigest !== undefined ? { judgeRun: this.manifest.judgeRunModelDigest } : {}),
    };
    return Object.keys(pins).length > 0 ? pins : undefined;
  }

  // The submit-time judge closure — the concretization SOURCE for judging, so a re-read judge executes the
  // documents this batch sealed rather than whatever the registry answers now.
  get sealedJudges(): SealedJudgeEntry[] | undefined {
    return this.manifest?.judges;
  }
}
