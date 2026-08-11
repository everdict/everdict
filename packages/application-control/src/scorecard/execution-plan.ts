import type { CaseJob, EvalCase, HarnessSpec, ScorecardManifest, ScorecardRecord } from "@everdict/contracts";
import { ConflictError } from "@everdict/contracts";
import { sealedExecutionMessage, verifySealedCaseDocuments, verifySealedSelection } from "@everdict/domain";
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
  //
  // ONCE AN ARTIFACT PROVES STRONGER KNOWLEDGE EXISTED, A LATER ABSENCE MAY NOT BE REINTERPRETED AS A WEAKER
  // LEGACY STATE (arch-review 22 P0-3). `undefined` here does NOT mean "this batch always ran a built-in
  // harness": `embedHarnessSpec` turns a registry NotFound into `undefined` so an unregistered/built-in
  // harness can still be dispatched by id. Both cases arrive as the same value, and the manifest is what
  // tells them apart — a `specDigest` is proof that a registry DOCUMENT was read and sealed here. If that
  // document has since vanished, continuing spec-less would execute a different, weaker thing under the
  // certified name, which is exactly the fail-open the delegated judge harness closed one level down.
  assertHarness(spec: HarnessSpec | undefined): void {
    const sealed = this.manifest?.harness.specDigest;
    if (spec === undefined) {
      if (sealed === undefined) return; // no document was ever sealed — built-in / unregistered, as at submit
      throw new ConflictError(
        "CONFLICT",
        { scorecard: this.ref.scorecardId, harness: this.ref.harness },
        `the harness '${this.ref.harness}' this batch sealed (${sealed}) is no longer registered in this workspace — the seal is proof a registry document was read, so its absence is a lost identity rather than a built-in harness. Refusing to execute something this batch never certified.`,
      );
    }
    this.refuse(
      verifySealedSelection(this.manifest, { cases: [], harnessSpec: spec, harnessRef: this.ref.harness }).filter(
        (m) => m.subject === "harness",
      ),
    );
  }

  // THE RE-SCORE VARIANT of the selection check (arch-review 22 P1). A detached pass judges the cases that
  // already have RESULTS, so the current dataset may legitimately be larger — what it may not be is missing
  // one of them. Different question, same artifact: the re-score path used to call the domain verifier
  // directly, which left a second reader of the manifest alive beside the one this class exists to be.
  assertJudgedCases(judgedCaseIds: readonly string[], resolved: ReadonlyArray<Pick<EvalCase, "id" | "graders">>): void {
    this.refuse(verifySealedCaseDocuments(this.manifest, judgedCaseIds, resolved));
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

  // The RUNTIME judge configuration this batch scored under — stamped onto each scoring revision, so a
  // judgment records which judging apparatus produced it and not merely which judges were listed.
  get sealedJudgeRun(): ScorecardManifest["judgeRun"] {
    return this.manifest?.judgeRun;
  }

  // WHAT THIS BATCH JUDGES UNDER — the composed policy embedded at submit, absent when the built-in ladder
  // decides. Read through the plan for the same reason as everything else here: a verdict is only
  // re-derivable if every reader resolves the same stamped document.
  get verdictPolicy(): ScorecardManifest["verdictPolicy"] {
    return this.manifest?.verdictPolicy;
  }

  // Did this batch seal CASE DOCUMENTS at all? The re-score path asks it to tell a batch whose dataset it
  // must re-verify from one that legitimately has no registry dataset behind it (an ad-hoc experiment, an
  // ingested trace) — the difference between "the documents moved" and "there were never any".
  get sealsCaseDocuments(): boolean {
    return this.manifest?.cases !== undefined;
  }
}
