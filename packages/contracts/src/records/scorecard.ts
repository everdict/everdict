import { z } from "zod";
import { JudgeRunConfigSchema } from "../execution/case-job.js";
import { GraderSpecSchema, PlacementOsSchema, ScorecardSchema } from "../execution/eval-case.js";
import { VerdictPolicyRefSchema, VerdictPolicySchema } from "../execution/verdict-policy.js";
import { GateDecisionSchema } from "./gate.js";

// Scorecard run lifecycle: accept a dataset×harness batch eval → run → success/failure.
// superseded = a terminal state where a newer fire of the same (origin.repo, prNumber, harness, dataset) reclaimed (cancelled·replaced) this batch.
// cancelled = a terminal state where a user explicitly stopped this batch (remaining cases not fired, in-flight runtime jobs force-killed) — a deliberate stop, not a newer fire.
// Both are neither failure nor success, so neither is counted in baseline/diff/leaderboard (succeeded only). The store keeps the record.
export const ScorecardStatusSchema = z.enum(["queued", "running", "succeeded", "failed", "superseded", "cancelled"]);
export type ScorecardStatus = z.infer<typeof ScorecardStatusSchema>;

// phase = the failed pipeline stage (dispatch|judges|metrics|offload|persist) — for "at which stage" diagnosis (jsonb, so no migration needed).
export const ScorecardRunErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  phase: z.string().optional(),
});

// Per-metric aggregate (isomorphic to @everdict/domain summarizeScorecard's result). The record shape is the SSOT here in contracts; domain computes it.
export const MetricSummarySchema = z.object({
  metric: z.string(),
  count: z.number(),
  // ABSENT when count is 0 (an annihilated metric — every score unmeasured/invalid): a mean over nothing is
  // not 0, and serving 0 crowned dead graders on lower-is-better leaderboards and drew outages as regressions.
  mean: z.number().optional(),
  passRate: z.number().optional(),
  // Categorical metrics (any score carried a `label`): the label distribution (ordered enum → ordinal order via the
  // scores' `value`, else by frequency) + the most-frequent label (mode). Present ONLY when the metric is categorical
  // — numeric/boolean metrics leave both unset and are read via mean/passRate. `mean` stays populated but is not shown.
  distribution: z.array(z.object({ label: z.string(), count: z.number().int().nonnegative() })).optional(),
  mode: z.string().optional(),
  // Scores of this metric that were NOT measurements (grader error / skip) — excluded from count/mean/passRate/
  // distribution above and surfaced as their own tally so a grader outage is visible instead of shifting the mean.
  // Present only when > 0.
  unmeasured: z.number().int().positive().optional(),
});
export type MetricSummary = z.infer<typeof MetricSummarySchema>;

// Reproducibility manifest — content digests of EXACTLY what this batch evaluated, sealed at submit. The
// registry rows (dataset/harness/graders) keep living; the manifest answers "was it exactly this document?"
// long after. Values are canonical-JSON content digests (@everdict/domain contentDigest) — `sha256:<64 hex>`
// since V1, bare 16-hex FNV on batches sealed before it (still verified under their own algorithm, so a
// legacy stamp keeps its identity-only reading forever). mig 0126. Absent on pre-manifest batches.
// trust-kernel contract ⑤.
// The manifest's DECLARED identity era (I8): which generation of seals this manifest carries. Before this,
// era was inferred from FIELD ABSENCE ("no `cases` map → pre-split seal", "judge entry without `model` →
// pre-closure seal") — and absence is ambiguous: "sealed by an old generation" and "sealed by the current
// generation over a facet that is genuinely empty" read identically. A manifest stamped with the current
// constant claims EVERY current facet was sealed — absence on such a manifest is a claim of emptiness, not
// a generation gap. Absent identityVersion = a legacy manifest (all pre-declaration generations); readers
// keep inferring for those, honestly downgraded. Bump the constant whenever a new facet joins the seal.
export const MANIFEST_IDENTITY_VERSION = 1;

// ONE JUDGE'S SEALED CLOSURE — defined ONCE (arch-review 20 P0-3).
//
// The manifest, the live scoring pass and the scoring revision all record the same thing: which judge document
// scored this, and what its own nested references resolved to. They had three separate literal definitions,
// and the moment the closure grew document digests only two of them were updated. The pass's was the one
// missed — and the pass is the AUTHORITY TOKEN an activity carries, so the loss was not cosmetic:
//
//   claim pass  → judges[].modelDigest present in memory
//   → Postgres  → reload → ScorecardRecordSchema.parse() drops what this schema does not name
//   → Temporal activity / reloaded re-score reads pass.judges as its sealed closure
//   → the nested verification has nothing to verify against
//
// A semantic capability that changes shape after serialization was never carried across the boundary. Sharing
// the schema is what makes that impossible to do by accident, which is the only way it stops happening.
export const SealedJudgeEntrySchema = z.object({
  id: z.string(),
  version: z.string(),
  specDigest: z.string().optional(), // the judge DOCUMENT this pass ran
  model: z.string().optional(), // "ref@version" | a raw binding verbatim | the honest "unresolved" sentinel
  rubric: z.string().optional(), // "id@version" | "unresolved"; absent = inline text or none
  harness: z.string().optional(), // a harness judge's delegated agent, same vocabulary
  // The nested DOCUMENTS those refs named at seal time (arch-review 19 P0-4) — what makes each ref verifiable,
  // since owner-first resolution can hand execution a different document under a held ref.
  modelDigest: z.string().optional(),
  rubricDigest: z.string().optional(),
  harnessDigest: z.string().optional(),
  // …and the delegated harness's OWN model closure, one level further down: pinning the agent document
  // proves which agent judges, not which model it thinks with.
  harnessModelDigest: z.string().optional(),
  harnessServiceModelDigests: z.record(z.string(), z.string()).optional(),
});
export type SealedJudgeEntry = z.infer<typeof SealedJudgeEntrySchema>;

export const ScorecardManifestSchema = z.object({
  identityVersion: z.number().int().positive().optional(), // declared seal era — absent = legacy (inferred)
  dataset: z.object({ id: z.string(), version: z.string(), digest: z.string() }), // digest over the resolved case bundle
  // ── The ORTHOGONAL identity axes (additive; the composite `dataset.digest` above hashes the post-subset,
  // post-grading-plan bundle and stays for verifyManifest + pre-split readers). `cases` maps caseId → a
  // SEMANTIC digest of the case with its `graders` default STRIPPED: the case contract itself calls that
  // field a runtime-replaced default, and hashing it as content made a grading-plan change move the dataset
  // axis and a subset selection move it too — one composite digest answering three different questions.
  // `grading` digests the EFFECTIVE grading semantics: the runtime plan when one was given, else the
  // per-case defaults keyed by case id — a default-grader edit is a grading claim, never a content claim.
  // `gradingCases` (H5) maps caseId → a digest of THAT case's default graders, so the grading axis can
  // compare SHARED cases only: the defaults `grading` composite is keyed by the selection, which made an
  // 80/100 subset read as a grading confound. `grading` stays (plan runs: the plan digest; defaults runs:
  // the selection-keyed composite, kept so equal composites still verify held against pre-gradingCases
  // records); absent gradingCases on a defaults run = a pre-H5 seal (differing composites read unverified
  // "composite", never a confound).
  cases: z.record(z.string(), z.string()).optional(),
  grading: z.string().optional(),
  gradingCases: z.record(z.string(), z.string()).optional(),
  // Resolved spec (specDigest absent: built-in with no declarative spec) + the sealed MODEL closure (H13 —
  // the judge argument, applied to the harness): a command harness's binding / each service's binding is a
  // ModelBinding whose `{ref}` without a version resolves LATEST at dispatch, so two batches with
  // byte-identical harness specs can execute under different models while specDigest reads held. `model`
  // (command) / `serviceModels` (service, keyed by service name) seal what the binding resolved to at submit
  // — "ref@version" | a raw binding verbatim | the honest "unresolved" sentinel. Absent = no binding (or a
  // pre-closure seal). The harness stays the TREATMENT: its closure confounds only when the harness identity
  // itself is held (experimentIdentity harness_model axis).
  harness: z.object({
    id: z.string(),
    version: z.string(),
    specDigest: z.string().optional(),
    model: z.string().optional(),
    serviceModels: z.record(z.string(), z.string()).optional(),
    // The model DOCUMENTS behind those refs (arch-review 19 P0-4) — same reason as the judge closure's: a
    // `{ref}` names whichever namespace answers, and everything that decides what the model IS lives in the
    // document, not in the ref.
    modelDigest: z.string().optional(),
    serviceModelDigests: z.record(z.string(), z.string()).optional(),
  }),
  graders: z.string().optional(), // digest of the run-time grading plan (absent = per-case defaults)
  // The selected judges with their resolved spec digests — WHICH judge documents scored this batch, not just
  // which ids (an edited judge under the same version would otherwise be indistinguishable). `model` seals the
  // CONCRETE model the judge's binding resolved to at submit — a raw binding verbatim, a registry ref as
  // "ref@version" after latest-resolution, or the "unresolved" sentinel when no resolver could answer. The
  // spec digest pins a DOCUMENT; a nested `{ref}` with no version pins a moving target, so two batches with
  // byte-identical judge specs can be judged by different models — the closure, not the top document, is the
  // identity. Absent model = the judge carries no binding (harness-delegating judge).
  // `rubric`/`harness` (H8) close the rest of the closure the same way: a rubric REF and a delegated
  // harness resolve at RUN time (latest allowed), so byte-identical specs can judge under different rubric
  // documents or delegate to different agents. Sealed as "id@version" (a latest ref pinned to the concrete
  // version at seal time; an explicit pin verbatim — registry versions are immutable) or the honest
  // "unresolved" sentinel. Absent rubric = inline text or none (both live inside specDigest); absent
  // harness = not a harness-delegating judge.
  // …and each nested ref's DOCUMENT digest beside it (arch-review 19 P0-4). A ref is `id@version`, and
  // resolution is owner-first over a `_shared` fallback — so the same ref names a different document once a
  // workspace registers its own, and a ref-only pin cannot tell: the string is identical. The model document
  // carries the provider, the underlying model, the base URL and the key secret; the rubric IS the question;
  // the delegated harness is the whole agent. Absent digest = the document could not be read at seal time,
  // which a verifier treats as "never pinned", never as agreement.
  judges: z.array(SealedJudgeEntrySchema).optional(),
  // The runtime judge configuration this batch scored under (request override → workspace default), with its
  // binding resolved the same way. It applies to INLINE judge graders too, so an identical judge list can
  // still be judged by a different model — orchestration always knew this; identity now does.
  judgeRun: z.object({ provider: z.string().optional(), model: z.string() }).optional(),
  // …and the DOCUMENT that ref named at seal time (arch-review 20 P0-4), kept beside `judgeRun` rather than
  // inside it: the series contract projects `judgeRun` verbatim into a comparison digest, so a facet the
  // resolved contract cannot know about would make every batch with a judge model read as a definition
  // change. The digest answers "is this the document we sealed?", which is a different question from "is
  // this the same experiment?" — and only the first one belongs at the dispatcher.
  judgeRunModelDigest: z.string().optional(),
  // The COMPOSED verdict policy this batch judges under, embedded IN FULL when it differs from the built-in
  // ladder: a composed document lives nowhere else, and a stamp whose document cannot be found is a verdict
  // that cannot be re-derived. Absent = the default ladder.
  verdictPolicy: VerdictPolicySchema.optional(),
});
export type ScorecardManifest = z.infer<typeof ScorecardManifestSchema>;

// The LIVE scoring pass (arch-review 7 P0, mig 0147) — the revision boundary made visible. A re-score
// legally rewrites the score plane in place (strip-first, per-case write-back), so between revision N and
// the N+1 append the persisted plane belongs to NO completed revision — and gate/diff/release/issue-watch
// readers could read it (the Temporal pass has no failure handling at all: a FAILED workflow silently left
// a plane whose judgments prepareScore had already deleted while the record kept advertising them). This
// marker is set BEFORE the first strip and cleared IN THE SAME WRITE as the revision append, so a trust
// reader can refuse the in-between instead of consuming it: a live pass = "the plane is between revisions",
// a `failed` (or stale `running`) pass = "the plane is broken evidence of an abandoned pass" — both refuse.
// It also replaces the process-local in-flight Set as the CROSS-REPLICA one-pass-at-a-time guard, and its
// pass-start judge closure is what the finalized revision records (sealed when the pass began, not observed
// at finalize). NULL/absent = no pass touched the plane since the last settle.
export const ScoringPassSchema = z.object({
  // ── Ownership (arch-review 8 P0). A marker says "a pass is running"; a TOKEN says "this pass, and only
  // this pass, may mutate the plane". The difference is the whole guarantee: without it two replicas both
  // read an absent marker, both write one, and the loser's late writes land on the winner's settled plane —
  // after the marker (the read guard) is already gone, so nothing refuses them.
  // `passId` IS the token — a UUID, never reused — and it is the ONLY authority: the claim CASes on it, every
  // later write is fenced on it, the settle is guarded by it.
  // Optional ONLY because rows written before this generation carry none — a marker with no passId is a
  // legacy marker: reclaimable by age, and never fenceable (a fenced write naming a passId refuses it,
  // which is the fail-closed reading of "written by a control plane that had no ownership model").
  passId: z.string().min(1).optional(),
  // ATTEMPT COUNTER — a DIAGNOSTIC, and deliberately not an authority (arch-review 10 §14). It once was the
  // fencing token, and it could not be one: a settle CLEARS the marker, so the next claim starts the count
  // over, and a stale writer holding "1" matched a completely different pass holding "1" (the ABA that
  // TRUST-42's fourth scenario pins). It survives only to answer "how many passes has this record had",
  // which is worth knowing and decides nothing. Nothing may key ownership, renewal or reclaim on it —
  // a non-authoritative concurrency number is the most dangerous field in a trust kernel, because the next
  // reader assumes a monotonic counter means what it usually means.
  epoch: z.number().int().positive().optional(),
  // ── Liveness. A LEASE, not an age: a healthy 1000-case pass legitimately runs longer than any fixed
  // window, and taking it over because it is "old" is how a working pass gets shot (the same lesson the
  // fleet permit already learned — TRUST-20 "a permit is a lease, not a timestamp"). The owner renews while
  // it works; only an expired lease (or a failed pass) is reclaimable.
  leaseUntil: z.string().optional(),
  heartbeatAt: z.string().optional(),
  targetRevision: z.number().int().positive(), // the revision this pass will append when it settles
  baseRevision: z.number().int().nonnegative(), // the completed revision the pass started from (0 = pre-ledger)
  // The selected judges' closure sealed at pass START (the same sealJudgeClosure submit uses).
  judges: z.array(SealedJudgeEntrySchema),
  startedAt: z.string(),
  startedBy: z.string().optional(),
  workflowId: z.string().optional(), // the Temporal score workflow driving it (absent = in-process)
  status: z.enum(["running", "failed"]),
  failedAt: z.string().optional(),
  failure: z.string().optional(),
});
export type ScoringPass = z.infer<typeof ScoringPassSchema>;

// How long a claim/renewal keeps the pass alive. Short enough that a crashed owner's record is reclaimable
// in minutes rather than an hour; safe because the owner RENEWS while it works (per case, per activity), so
// the window bounds "how long since this pass last proved it was alive", never "how long the pass may run".
export const SCORING_PASS_LEASE_MS = 5 * 60 * 1000;
// Renew when less than this remains — a heartbeat that only fires at expiry has no margin for a slow write.
export const SCORING_PASS_RENEW_BEFORE_MS = 2 * 60 * 1000;
// (legacy) the pre-lease takeover window, kept for records whose marker predates leaseUntil: a running pass
// with no lease is judged by its startedAt age, exactly as before, so old rows stay reclaimable.
export const SCORING_PASS_STALE_MS = 60 * 60 * 1000; // one hour — the activity startToClose ceiling

// May a NEW pass take this marker over? Failed = yes (crash residue must never wedge a record forever), an
// EXPIRED lease = yes (the owner stopped proving it was alive), a live lease = NO however long it has been
// running. A marker without a lease is legacy and falls back to the age rule.
// Pure/total and consumed beneath the domain cone (the score service, the store guards, the trust suite).
export function scoringPassReclaimable(
  pass: Pick<ScoringPass, "status" | "startedAt"> & { leaseUntil?: string },
  now: string,
): boolean {
  if (pass.status === "failed") return true;
  const at = Date.parse(now);
  if (pass.leaseUntil !== undefined) return Date.parse(pass.leaseUntil) <= at;
  return at - Date.parse(pass.startedAt) >= SCORING_PASS_STALE_MS;
}

// Scoring identity — one entry per SCORING PASS over this group, append-only (mig 0144). The live score
// plane legally mutates in place on a re-score (write-back replaces the selected judges' rows), but a
// Scorecard ID that silently means different judgments over time is identity drift the manifest alone cannot
// see: the manifest says what was EVALUATED, this ledger says what was JUDGED, and when. Each pass records
// the selected judges with their sealed model closures and a content digest of the whole score plane it left
// behind — so "which judgment did you read" is answerable after the fact (gate decisions pin it:
// GateDecision.baselineScoring/candidateScoring). `judges` is the pass's SELECTED set only — a re-score
// replaces the selected judges' rows and keeps every other score (replace-selected / keep-others); the
// record's manifest/orchestration judge views are refreshed to the merged EFFECTIVE set at the same write.
export const ScoringRevisionSchema = z.object({
  revision: z.number().int().positive(), // 1-based, strictly increasing per record
  kind: z.enum(["initial", "rescore"]),
  judges: z.array(SealedJudgeEntrySchema),
  // The runtime judge configuration in effect for the pass — rides the INITIAL pass only (it governs inline
  // judge graders, which a detached re-score never touches).
  judgeRun: z.object({ provider: z.string().optional(), model: z.string() }).optional(),
  // contentDigest over the FULL score plane as of this pass (caseId#trial → judgment-projected scores) — two
  // reads that disagree on it read different judgments, whatever the record id says.
  scorePlaneDigest: z.string(),
  // The analysis artifact frozen from THIS pass's plane (absent: no artifact store / offload failed / the
  // stamped verdict policy could not be restored, in which case re-freezing would rewrite history).
  analysisRef: z.string().optional(),
  // Its durable object KEY. `analysisRef` is a presigned URL that expires, and the key stopped being
  // derivable from the revision number when artifacts became pass-scoped (two passes can target one
  // revision, and the object store has no CAS to decide between them) — so the entry records where its own
  // bundle lives. Absent on pre-pass-keyed revisions, which still resolve through the legacy derived key.
  analysisKey: z.string().optional(),
  // HOW THE STAGE COMPARED TO THE PLANE THIS REVISION CERTIFIES (arch-review 16 P1-6).
  //
  // The stage promotion — moving the score plane's source of truth off the carriers and onto the staged rows
  // — is gated on having watched the two agree on real traffic. That evidence was a process metric: a
  // fire-and-forget callback after settle, turned into counters. A counter cannot be re-read per pass, and a
  // control plane that died between the settle and the callback left the pass with NO observation at all,
  // silently indistinguishable from an agreeing one. A promotion decision cannot rest on evidence that
  // disappears when the thing it observes crashes.
  //
  // Recorded here, on the revision, because the revision IS the pass's durable statement about its plane —
  // and it is written in the same guarded update, so a settled revision always carries its own observation.
  // `promotionSafe` is the predicate the contract step gates on, decided at the one moment every input to it
  // is in hand. Absent = a revision from before this existed, or a pass with no stage wired: honestly
  // unobserved, which is exactly what it must not be confusable with.
  stageParity: z
    .object({
      // WHICH OBSERVER PRODUCED THIS (arch-review 23 P1). Evidence is only meaningful together with the
      // decision procedure that produced it, and this comparison has changed meaning repeatedly:
      // stage-sourced expectation → settled-plane expectation, per-case → per-judge units, silent zero-work
      // reports → `completed`, JSON.stringify equality → canonical Score equality. A `promotionSafe: true`
      // from an earlier, weaker observer is not the same certification as one from today's, and the contract
      // step must not be able to consume it. Absent = an era before this stamp, which the readiness gate
      // counts as unobserved rather than as agreement.
      version: z.number().int().positive().optional(),
      completed: z.boolean(), // false = the comparison itself could not run; `failure` says why
      failure: z.string().optional(),
      expectedJudged: z.number().int().nonnegative(), // units this pass actually judged (from the settled plane)
      staged: z.number().int().nonnegative(),
      matched: z.number().int().nonnegative(),
      missingFromStage: z.number().int().nonnegative(),
      mismatched: z.number().int().nonnegative(),
      orphaned: z.number().int().nonnegative(),
      promotionSafe: z.boolean(),
      // WHICH units disagreed, not just how many (arch-review 17 P1-7). The counts make the promotion
      // decision; these make it DIAGNOSABLE. The stage rows are collected immediately after this observation
      // is written, so a `promotionSafe: false` investigated later would otherwise know that three judgments
      // disagreed and have no way left to learn which three — the evidence is gone by construction.
      //
      // Bounded on purpose: a pass that disagrees on thousands of units has a systemic fault, and the first
      // few name it as well as all of them would. `truncated` says the list was cut, so a reader never
      // mistakes a bounded sample for the whole set.
      units: z
        .object({
          missingFromStage: z.array(z.string()),
          mismatched: z.array(z.string()),
          orphaned: z.array(z.string()),
          truncated: z.boolean(),
        })
        .optional(),
    })
    .optional(),
  createdAt: z.string(),
  createdBy: z.string().optional(),
});
export type ScoringRevision = z.infer<typeof ScoringRevisionSchema>;

// The batch's OWN verdict aggregate — computed under the STAMPED verdict policy at settle and PERSISTED
// (arch-review 7 §4). headlinePassRate ranks metrics by a hardcoded authority ladder that cannot know a
// composed policy's custom ground_truth metrics, so a surface acting on the headline (product timeline,
// release readiness, dashboards) could contradict the actual case verdicts. This is the number those
// surfaces read: passed/failed/verdicted over authority-ranked caseVerdict under the batch's own policy,
// with the policy's digest stamped so a stale aggregate (e.g. after a re-score whose stamp could not be
// restored) is DETECTABLE against record.verdictPolicy.digest instead of silently trusted.
export const VerdictSummarySchema = z.object({
  verdicted: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  // ABSENT when verdicted === 0 — a rate over nothing is absence, never 0 (the annihilated-metric rule).
  passRate: z.number().optional(),
  policyDigest: z.string(),
});
export type VerdictSummary = z.infer<typeof VerdictSummarySchema>;

// The scorecard's denominators (isomorphic to @everdict/domain scorecardOutcomes) — served next to casePass so
// no client conflates 841/970 (verdicted) with 841/1000 (requested). infraFailed cases carry NO product verdict;
// they are recovery work, never product failures. DERIVED on read, never persisted.
export const ScorecardOutcomesSchema = z.object({
  executed: z.number().int().nonnegative(),
  gradeable: z.number().int().nonnegative(),
  verdicted: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  infraFailed: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(), // killed mid-case with a result (unlaunched = requested − executed)
  unmeasured: z.number().int().nonnegative(),
  requested: z.number().int().nonnegative().optional(),
});
export type ScorecardOutcomes = z.infer<typeof ScorecardOutcomesSchema>;

// Trial-based verdict roll-up (pass@k / flakiness) — isomorphic to @everdict/domain summarizeTrials's result (shape
// mirror only; db depends on core, not suite). DERIVED on read from the scorecard's repeated trials (like
// RunRecord.usage from the trace) — never persisted; present only on a multi-trial batch's detail. docs/architecture/trial-based-verdict.md
export const ScorecardTrialSummarySchema = z.object({
  cases: z.number(), // cases with >=1 scored trial
  minTrials: z.number(),
  maxTrials: z.number(),
  passAt1: z.number(), // mean over cases of the per-case pass rate
  k: z.number(), // the k used for passAtK
  passAtK: z.number(),
  flakyCases: z.number(), // cases with mixed pass/fail across trials
  flakeRate: z.number(),
});
export type ScorecardTrialSummary = z.infer<typeof ScorecardTrialSummarySchema>;

// The models this run actually used (leaderboard model axis, isomorphic to @everdict/domain scorecardModels's result — shape mirror only).
// observed = observed from the trace · declared = declared in the spec · primary = group key (observed first, else declared). Lightweight, so included in list too.
export const ScorecardModelsSchema = z.object({
  observed: z.array(z.string()).default([]),
  declared: z.string().optional(),
  primary: z.string().optional(),
});
export type ScorecardModels = z.infer<typeof ScorecardModelsSchema>;

// The trigger provenance of this scorecard run — where it was fired from (schedule|github-actions|api|web…) + commit coordinates.
// A GitHub Actions PR fire records the submit-time ephemeral pins (pinOverrides: slot→image) here — the registry is unchanged, so
// this field is the reproducibility basis for "what it was evaluated with". Lightweight → included in list too. Pg is origin jsonb (mig 0033, additive).
export const ScorecardOriginSchema = z.object({
  source: z.string(), // schedule|github-actions|api|web…
  // Causation as a first-class edge (execution-model P3): the agent RUN whose action submitted this batch.
  // Children inherit it as origin{cause:"run", causedByRunId} — the demand graph the P4 gate walks.
  causedByRunId: z.string().optional(),
  // The schedule that fired this run (source === "schedule"). Lets a schedule's detail view list its own run
  // history (regression over time) — the only link otherwise is Schedule.lastScorecardId (the latest fire).
  scheduleId: z.string().optional(),
  repo: z.string().optional(), // "owner/name"
  sha: z.string().optional(),
  ref: z.string().optional(), // refs/heads/… | refs/pull/…
  prNumber: z.number().int().optional(),
  runUrl: z.string().optional(), // CI run link
  pinOverrides: z.record(z.string()).optional(), // submit-time ephemeral pins (slot→image) — records the PR image swap
  // Product-timeline provenance (source === "product", records/product.ts): the product whose service version
  // import fanned this batch out, the watch series it belongs to, and — when a planned release scoped the run —
  // the release. `seriesKey` is the trend's x-axis key: "how did this series move" is a list filter over these
  // stamps, so the fields live here rather than in a join table. `serviceVersion` is "<service>@<version>",
  // the ledger row that caused the run — the timeline's link from a scorecard point back to what changed.
  productId: z.string().optional(),
  releaseId: z.string().optional(),
  seriesKey: z.string().optional(),
  // WHICH DEFINITION of that series this batch actually evaluated (arch-review 13 P0) — the resolved
  // dataset / harness / judge closure, digested.
  //
  // `seriesKey` is the TREND's identity: it is deliberately stable so relabeling a series never re-keys its
  // history. That stability made it the wrong thing to select release evidence by. A series is also a
  // CONTRACT — `{dataset, harness, judges}`, with absent versions meaning "latest at run time" — and the
  // release read picked "the newest succeeded scorecard stamped with this key", so editing the series to a
  // new dataset left yesterday's green result standing as today's evidence. Worse for `latest` refs: the
  // product row need not change at all for the contract underneath it to move, so no CAS and no policy
  // digest could ever have caught it.
  //
  // Stamped at submit from the CONCRETE closure the batch ran under, and compared at readiness against the
  // series as it stands now. Absent = a batch from before this existed, or one whose contract could not be
  // resolved: evidence whose contract cannot be named, which a release must not count as current.
  seriesContractDigest: z.string().optional(),
  serviceVersion: z.string().optional(),
  // Lineage of a retry-failed run — the source scorecard this record re-ran the failed cases of (passing results
  // carried over verbatim). The source record itself is never mutated. docs/architecture/batch-resilience.md
  retryOf: z.string().optional(),
  // OOM escalation state (per case, Mb) — the memory this retry ran the case with after doubling on OOM_KILLED.
  // The next retry reads it as its base, so repeated retries compound (64 → 128 → 256 …) up to the cap. The
  // registry spec itself is never mutated — the boost rides the job only. docs/architecture/batch-resilience.md
  memoryBoostMb: z.record(z.number()).optional(),
});
export type ScorecardOrigin = z.infer<typeof ScorecardOriginSchema>;

// Execution steps (timeline) — appended as the run progresses to show "progress" (incremental store).
// phase = dispatch|judges|metrics|offload|persist|case, status = started|ok|failed|info.
// Pg is a steps jsonb column (mig 0026, additive). Heavy detail, so it's omitted from list and returned only in get.
export const ScorecardStepSchema = z.object({
  ts: z.string(),
  phase: z.string(),
  status: z.enum(["started", "ok", "failed", "info"]),
  message: z.string(),
  caseId: z.string().optional(),
});
export type ScorecardStep = z.infer<typeof ScorecardStepSchema>;

// Partial run (subset) — which subset of the dataset this batch ran. Unset = full run.
// The marker is what lets consumers (list/detail/diff/leaderboard) know "this is not the full result". Lightweight → included in list too. mig 0043.
export const ScorecardSubsetSchema = z.object({
  total: z.number().int().nonnegative(), // total case count of the dataset at submit time
  selected: z.number().int().nonnegative(), // number of cases actually run
  ids: z.array(z.string()).optional(), // explicitly selected case ids
  tags: z.array(z.string()).optional(), // tag filter (any-match)
  limit: z.number().int().positive().optional(), // first N after applying the filter
});
export type ScorecardSubset = z.infer<typeof ScorecardSubsetSchema>;

// Trace-sink export result — the record of exporting per-case trace+scores to the workspace observability platform after scoring completes.
// A failure does not affect the scorecard status (status lives only here). Preserves per-case external trace ids/links
// (so the pull-ingest runs mapping doesn't get lost). Pg is sink_export jsonb (mig 0048, additive).
// Design: docs/architecture/trace-sink.md
export const ScorecardExportSchema = z.object({
  sink: z.enum(["mlflow", "langfuse", "langsmith", "phoenix"]),
  name: z.string().optional(), // the sink name used (which one among multiple sinks — unset for past records)
  status: z.enum(["succeeded", "partial", "failed"]),
  url: z.string().optional(), // top-level (experiment/project) deep link
  message: z.string().optional(), // failure/partial reason
  exportedAt: z.string(),
  cases: z
    .array(
      z.object({
        caseId: z.string(),
        externalId: z.string().optional(), // platform trace/run id (the target created or attached)
        url: z.string().optional(), // case trace deep link
        error: z.string().optional(), // per-case failure (isolated — other cases keep exporting)
      }),
    )
    .optional(),
});
export type ScorecardExport = z.infer<typeof ScorecardExportSchema>;

// Reserved sentinel id used for a scorecard's `dataset` (and `harness`) when it scores observability traces DIRECTLY —
// the "evaluate existing traces" path (pick traces from a workspace trace source + run judges, no dataset, no harness
// run). It keeps the NOT-NULL dataset/harness columns populated WITHOUT a real registry entry, so no schema migration
// is needed. A leading underscore mirrors the reserved `_shared` tenant convention. Consumers detect a trace-evaluation
// scorecard by `dataset.id === TRACE_EVAL_REF` (this id never collides with a real, registrable dataset id) and render
// it without a dataset/harness deep-link. It also self-excludes from leaderboard/trend, which positively filter by a
// real datasetId. docs/scorecards.md
export const TRACE_EVAL_REF = "_traces";

// The reserved trace-source name that points the PULL machinery at everdict's OWN trajectory store
// (native-observability N2, continuous evaluation): pull-ingest and pull-mode schedules read the sealed
// trajectories directly — no external platform, no re-upload. A workspace source may not take this name.
export const EVERDICT_TRACE_SOURCE = "everdict";

// Reserved sentinel dataset ref for an EXPERIMENT over an ad-hoc task (execution-model.md P1) — "drive this
// harness on a one-off prompt, N times" has no registrable dataset, so the NOT-NULL dataset columns carry
// this sentinel (same convention as TRACE_EVAL_REF). An ad-hoc experiment is NOT re-drivable after a
// control-plane restart (there is no registry entry to re-plan from — the recovery path settles it like a
// pre-caseSpec record); dataset-backed experiments re-drive normally.
export const EXPERIMENT_ADHOC_REF = "_adhoc";

export const ScorecardRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  // The team that produced this result — the same axis the eval assets carry, so "what has our team
  // evaluated" is answerable without walking every harness. Optional because pre-team rows and ownerless
  // runs genuinely exist: absence means "no owner", never "everyone's".
  teamId: z.string().optional(),
  // Group kind (execution-model.md P1, decision O3: the RunGroup generalizes ScorecardRecord IN CONCEPT, the
  // table is kept). "experiment" = phase 1 alone — same fan-out, same child runs, NO judges/graders and no
  // verdict pressure (caseVerdict stays undefined; analytics exclude it). Absent = a scorecard (the default);
  // "scorecard" is written EXPLICITLY only when scoring promotes an experiment (P2 — a group with a verdict
  // is definitionally a scorecard).
  kind: z.enum(["scorecard", "experiment"]).optional(),
  dataset: z.object({ id: z.string(), version: z.string() }),
  harness: z.object({ id: z.string(), version: z.string() }), // resolved concrete version (never "latest")
  status: ScorecardStatusSchema,
  summary: z.array(MetricSummarySchema).optional(), // lightweight aggregate (for listing)
  // The stamped-policy verdict aggregate — persisted at every judged settle (succeed / re-score / ingest),
  // refreshed by a re-score alongside the scoring revision. Lightweight → included in list too (the product
  // timeline and release readiness read the LIST shape). mig 0146. Absent on pre-field and failed/aborted
  // settles.
  verdictSummary: VerdictSummarySchema.optional(),
  // Trial roll-up (pass@k / flakiness) — DERIVED on get() from the scorecard's repeated trials, never stored (like
  // RunRecord.usage). Present only when the batch ran trials>1. docs/architecture/trial-based-verdict.md
  trialSummary: ScorecardTrialSummarySchema.optional(),
  // Remaining wall-clock estimate (seconds) — DERIVED on get() for a RUNNING batch from its own finished
  // children (median duration × remaining / concurrency). Never stored. docs/architecture/work-queue.md
  etaSeconds: z.number().optional(),
  models: ScorecardModelsSchema.optional(), // the models this run used (leaderboard axis, lightweight → included in list too). Unset for past records.
  // The judge model(s) of this record's CURRENT effective judge set — if the model axis is 'the LLM the
  // harness used', this is the 'grader'. Filter/display for fair comparison (same judge). Distinct of inline
  // judge config.model + registered model-judge spec.model; a re-score RECOMPUTES it over the merged
  // effective set (never a union with history — a replaced judge's model is no longer this record's judge).
  // Per-pass truth lives in `scoring[]`. Lightweight → included in list too.
  judgeModels: z.array(z.string()).optional(),
  origin: ScorecardOriginSchema.optional(), // trigger provenance — lightweight, so included in list too. Unset for past records.
  // Runner (submitter subject) — to show/filter "who ran it" (avatar+name). If origin.source is 'where', this is 'who'.
  // Same pattern as datasets/harnesses' created_by. Unset for past records and machine-fired runs (no subject). Lightweight → included in list too.
  createdBy: z.string().optional(),
  // The runtime it was placed on (placement.target) — the work-queue's "where does it run" axis. Unset = default backend. mig 0040.
  runtime: z.string().optional(),
  subset: ScorecardSubsetSchema.optional(), // partial-run marker (unset for a full run)
  // Orchestration inputs needed to re-drive this batch after the fact (restart resume / retry-failed):
  // selected Agent Judges + inline judge model + concurrency + transient-retry count. Persisted at submit
  // (mig 0049); records without it (pre-field) cannot be faithfully resumed. docs/architecture/batch-resilience.md
  orchestration: z
    .object({
      judges: z.array(z.object({ id: z.string(), version: z.string() })).default([]),
      // Run-time grading plan — replaced every case's default graders at submit; persisted so resume/retry/
      // workflow re-plans score exactly like the original. docs/architecture/eval-domain-model.md S5
      graders: z.array(GraderSpecSchema).optional(),
      judge: JudgeRunConfigSchema.optional(), // inline judge model = a Model binding (ref | raw string), same as the job/settings shape
      concurrency: z.number().int().positive(),
      retries: z.number().int().min(0).default(0),
      // Run each case N times for pass@k / flakiness. Absent = 1 (single run). Persisted so a re-drive keeps the
      // trial count. docs/architecture/trial-based-verdict.md
      trials: z.number().int().positive().optional(),
      // Set when a Temporal workflow owns this batch's driver loop — boot recovery leaves such batches alone
      // (they own themselves) and the web can deep-link the workflow. docs/architecture/temporal-batch-orchestration.md
      workflowId: z.string().optional(),
      // Per-batch trace-sink override — a configured sink name, or "none" to suppress export for this batch.
      // Persisted so resume/retry keep the same destination. docs/architecture/trace-sink.md
      traceSink: z.string().optional(),
      // In-batch OOM auto-boost (opt-in) — an OOM_KILLED case re-dispatches inside the batch with doubled
      // job-only memory up to the cap. Persisted so resume keeps the behavior. docs/architecture/batch-resilience.md
      oomAutoBoost: z.boolean().optional(),
    })
    .optional(),
  scorecard: ScorecardSchema.optional(), // full per-case results (for detail, heavy)
  // Object-store ref to the self-contained ANALYSIS artifact (the analysis result as a first-class object): the
  // dataset/harness + aggregate summary + per-case verdict/scores, generated at finalize. Downloadable/shareable/
  // archivable independent of the DB (the analysis-output sibling of the run-output snapshot artifacts). Best-effort —
  // absent when no ArtifactStore is configured or the offload failed.
  analysisRef: z.string().optional(),
  export: ScorecardExportSchema.optional(), // trace-sink export result (for detail — get only, like steps)
  // WHICH verdict policy produced this batch's verdicts (id + version + content digest). Verdicts are derived
  // on read, so this stamp is what keeps a historical verdict stable when the policy evolves: readers resolve
  // the STAMPED policy (resolvePolicyResolution), never silently the newest one — a stamp that cannot be
  // restored withholds the verdict instead of falling back. Absent on batches settled before
  // the stamp existed — those were judged under the authority ladder the default policy encodes. mig 0125.
  verdictPolicy: VerdictPolicyRefSchema.optional(),
  // THE WORLD THIS BATCH RAN IN (arch-review 19 P2) — derived at settle from the cases' own execution
  // manifests, so it reports rather than declares. Deliberately NOT part of the evaluation contract: the
  // contract seals what is being asked, and folding the world into it would make every infrastructure move
  // invalidate a product's whole evidence base. It is a COMPARISON axis — two runs of one contract in
  // different worlds answered the same question under different conditions, and a difference between them
  // cannot be attributed to the change alone. Absent = no case reported a world (a dispatch that died, an
  // ingested trace), which reads as "not recorded", never as a default.
  world: z
    .object({
      os: PlacementOsSchema.optional(),
      // In-sandbox compute (`Driver.id`) and PLACEMENT (`TopologyRuntime.id`) are separate namespaces — the
      // two execution layers this system is built around. Merged into one list they deduped against each
      // other, so "docker the driver" and "docker the runtime" read as one condition (arch-review 20 P2).
      drivers: z.array(z.string()).optional(),
      runtimes: z.array(z.string()).optional(),
      images: z.array(z.string()).optional(),
      mixed: z.boolean(),
      observed: z.number().int().nonnegative(),
      // …out of how many cases. `observed` alone cannot distinguish a world every case agreed on from one
      // two cases out of a hundred happened to report — the same number, very different confidence. Optional:
      // a cohort derived before this field existed knows its numerator and not its denominator, and inventing
      // one would be a claim about coverage nobody measured.
      total: z.number().int().nonnegative().optional(),
    })
    .optional(),
  manifest: ScorecardManifestSchema.optional(), // reproducibility digests, sealed at submit (mig 0126)
  // Release-gate decisions recorded AGAINST this candidate (A1/B1) — append-only; the audit report scans
  // these instead of a separate store (ledger-derivation principle). mig 0128.
  gates: z.array(GateDecisionSchema).optional(),
  // Scoring identity ledger — one entry per scoring pass (the initial settle + each re-score), append-only
  // even though the live score plane mutates in place. mig 0144. Absent on pre-ledger batches and on failed/
  // aborted settles (they never gate, so they carry no judgment to identify — a named deferral).
  scoring: z.array(ScoringRevisionSchema).optional(),
  // The LIVE scoring pass (mig 0147) — set before the first strip, cleared in the settle write; trust
  // readers refuse while present. `null` is the CLEAR value on the update wire (a Partial patch cannot
  // express deletion with undefined); readers treat null and absent alike. Rides the LIST projection —
  // product readiness and the regression watch decide on list/get rows and must see it.
  scoringPass: ScoringPassSchema.nullable().optional(),
  // The batch's ASK — cases × trials at submit (ingest: the trace count). The requested−executed gap is the
  // unlaunched/cancelled tally no per-result walk can recover once cases were skipped. mig 0127.
  requested: z.number().int().nonnegative().optional(),
  // Which version of the span→event PROJECTION this batch was judged under (N6,
  // docs/architecture/otel-trace-model.md). Spans are immutable once ended, so the record is stable — but the
  // projection is code, and a verdict nobody can re-derive is a verdict nobody can defend. Storing the version
  // rather than a second copy of the events keeps ONE copy of the truth and still dates the interpretation.
  // Absent on batches judged before N6 (they were scored against events that WERE the record).
  traceProjectionVersion: z.number().int().positive().optional(),
  error: ScorecardRunErrorSchema.optional(),
  steps: z.array(ScorecardStepSchema).optional(), // execution timeline (appended even while in progress)
  // The ids of the child runs this batch fanned out (if any). scorecard = run × N expressed as references — a per-case addressable run drill-down.
  // A lightweight reference separate from the heavy scorecard (embedded results). get only (like steps) — for detail. Unset for past records/ingest paths.
  runIds: z.array(z.string()).optional(),
  // WHICH control-plane replica is driving this batch (mig 0135, docs/architecture/multi-replica.md) — the
  // same stamp runs carry, for the same reason: a booting replica must be able to tell a batch whose driver
  // DIED from one another live replica is still fanning out. Absent = unowned (pre-column rows, the in-memory
  // store), which recovery reclaims exactly as it always did.
  ownerReplica: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ScorecardRecord = z.infer<typeof ScorecardRecordSchema>;
