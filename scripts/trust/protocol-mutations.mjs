#!/usr/bin/env node
// ── DOES THE SUITE ACTUALLY CATCH THIS? (arch-review 53, Wave F) ────────────────────────────────────
//
// A green suite proves the tests pass. It does not prove they would FAIL if the protocol were removed — and
// this program has twice shipped a guard that was green over the very defect it was written for (review 30's
// scanner draft, and Wave 5's judgment fixture that judged an embed group no carrier ever adopted). The
// difference between a test and a certification is whether anyone tried to break it.
//
// This applies one MUTATION at a time to a production file, runs the suite that is supposed to notice, and
// requires it to go RED. A mutation that leaves the suite green is reported as a hole: either the protocol is
// unenforced or the test is asserting something else.
//
// Every mutation is reverted in a `finally`, and the script refuses to start on a dirty worktree for those
// files — an interrupted run must never leave a neutered guard behind.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const MUTATIONS = [
  {
    // arch-review 58 P1. Millicores and megahertz shared one `??` chain, so a two-vCPU case was placed as
    // 2000 MHz while the lane's world proof attested the declared box — a unit error walking straight through
    // the check built to catch an unenforced world.
    name: "R58 — a millicore cpu declaration is placed as megahertz",
    file: "packages/backends/src/orchestrators/nomad.ts",
    from: "  return Math.round((declaredMillicores / 1000) * opts.cpuMhzPerCore);",
    to: "  return declaredMillicores;",
    suite: ["--root", "packages/backends", "src/orchestrators/nomad-cpu-units.counterexample.test.ts"],
  },
  {
    // arch-review 58 P1. The verifier applied the agent's diff into a fresh container without confirming the
    // container was checked out at the baseline the diff was computed against. `git apply` matches on
    // context, so a wrong baseline does not reliably fail — it succeeds and yields a tree the agent never
    // made, and the verdict is real evidence about the wrong world.
    name: "R58 — a verifier applies the diff without confirming the baseline",
    file: "packages/job-runner/src/verifier-job.ts",
    from: '    if (job.workspace.headSha !== "") {',
    to: "    if (false) {",
    suite: ["--root", "packages/job-runner", "src/verifier-baseline.counterexample.test.ts"],
  },
  {
    // arch-review 58 P1. A recovery pass resumes batches, so outliving the 60s interval is ordinary — and the
    // timer forked on exactly that, re-driving live work and writing a stale worklist back over what the
    // running pass had discharged.
    name: "R58 — the deferred-recovery sweep forks on a slow pass",
    file: "apps/api/src/composition/runtime-access.ts",
    from: "    if (this.running) return;",
    to: "",
    suite: ["--root", "apps/api", "src/composition/deferred-recovery-sweep.counterexample.test.ts"],
  },
  {
    // arch-review 58 P0. The job payload stayed in `process.env` after the runner decoded it, and every exec
    // the runner starts inherits the environment — including the agent under test, which could read the repo
    // token, the registry passwords, the provider key and its own grading configuration out of it.
    name: "R58 — the job payload is left in the agent's environment",
    file: "packages/job-runner/src/job-payload-env.ts",
    from: "  delete process.env[VERIFIER];",
    to: "",
    suite: ["--root", "packages/job-runner", "src/job-payload-env.counterexample.test.ts"],
  },
  {
    // arch-review 58 P0. The verifier opened its own row with no parent, so `PARENT_AUTHORIZES` took the run
    // branch on every batch case (an execution id no run row can equal) and the scorecard teardown's worklist
    // could not see the row at all. Dropping the coordinate must go red, or the second unit is orphaned again.
    name: "R58 — a verifier attempt is opened with no parent",
    file: "packages/application-control/src/execution/verifier-pass.ts",
    from: "    ...(job.batchId !== undefined ? { scorecardId: job.batchId } : {}),",
    to: "",
    suite: ["--root", "packages/application-control", "src/execution/verifier-parent-authority.counterexample.test.ts"],
  },
  {
    // …and the coordinate has to reach the OPEN, not merely the job. Two hops, two ways to lose it.
    name: "R58 — the verifier job's parent never reaches the ledger",
    file: "packages/application-control/src/execution/verifier-operation.ts",
    from: "    ...(job.scorecardId !== undefined ? { scorecardId: job.scorecardId } : {}),",
    to: "",
    suite: ["--root", "packages/application-control", "src/execution/verifier-parent-authority.counterexample.test.ts"],
  },
  {
    // arch-review 58 P1. The terminal CAS is where a verdict re-proves its authorization is still live.
    // Ignoring the answer must go red, or a cancelled attempt's verdict is a measurement again.
    name: "R58 — a verifier verdict is returned without re-proving its authority",
    file: "packages/application-control/src/execution/verifier-operation.ts",
    from: '    if (!(await attempts.transition(attemptId, "committed"))) {',
    to: '    await attempts.transition(attemptId, "committed");\n    if (false) {',
    suite: ["--root", "packages/application-control", "src/execution/verifier-settlement.counterexample.test.ts"],
  },
  {
    // arch-review 58 P0. The verifier's scores travelled down the CASE result pipe under a cast, and the
    // reader on the other side runs `CaseResultSchema.parse()` — where `snapshot` is required and a verifier
    // has none. Every verifier verdict died at that parse. Neutralizing the separation must go red, or the
    // two documents are back to sharing a sentinel.
    name: "R58 — a verifier result is printed as a case result",
    file: "packages/contracts/src/execution/verifier-result-wire.ts",
    from: 'export const VERIFIER_RESULT_SENTINEL = "__EVERDICT_VERIFIER_RESULT__ ";',
    to: 'export const VERIFIER_RESULT_SENTINEL = "__EVERDICT_RESULT__ ";',
    suite: ["--root", "packages/contracts", "src/execution/verifier-result-wire.counterexample.test.ts"],
  },
  {
    // arch-review 58 P0. `active` was added between `reserved` and the external object's birth without being
    // added to the transition table beside it. Neutralizing it must go red, or a managed dispatch is back to
    // walking reserved → active → (executing REFUSED) → committed with no phase saying it ran.
    // Aimed at the CONSUMER's guard, not at the shared constant it reads. A mutation in another package's
    // `src` is invisible to a suite that resolves that package through its built `dist`: the first draft of
    // this entry edited the contracts list, the suite stayed green, and the mutation runner caught what a
    // rebuild would have hidden. Neutralize a protocol where the code under test actually reads it.
    name: "R58 — an activated attempt may not report that it started",
    file: "packages/application-control/src/ports/execution-attempt-store.ts",
    from: '    if (to === "executing" && !EXECUTING_PREDECESSOR_STATES.includes(current.state)) return false;',
    to: '    if (to === "executing" && current.state !== "created" && current.state !== "reserved") return false;',
    suite: ["--root", "packages/application-control", "src/ports/executing-after-active.counterexample.test.ts"],
  },
  {
    // …and the Pg twin arbitrates the same question in SQL, so it is neutralized separately. Two twins, two
    // mutations — a shared constant does not make them one enforcement point.
    name: "R58 — the Pg twin refuses executing from an activated attempt",
    file: "packages/db/src/results/pg-execution-attempt-store.ts",
    from: "const EXECUTING_FROM_LIST = EXECUTING_PREDECESSOR_STATES.map((s) => `'${s}'`).join(\", \");",
    to: "const EXECUTING_FROM_LIST = \"'created', 'reserved'\";",
    suite: ["--root", "packages/db", "src/results/pg-execution-attempt-store.test.ts"],
  },
  {
    // arch-review 58 P0. The activation state machine shipped with no production producer, so every managed
    // dispatch still spent a reservation nothing had re-checked. Removing the supplier must go red, or the
    // conditional transition is decoration again.
    name: "R58 — the activation transition loses its production producer",
    file: "packages/application-control/src/run/run-service.ts",
    from: "        onActivate: (work) => this.activateWork(id, work),",
    to: "",
    suite: ["--root", "packages/application-control", "src/run/activation-supplier.counterexample.test.ts"],
  },
  {
    // arch-review 58 P1-high. The monotonic projection guard named `export`, which is no column of
    // `everdict_scorecards` (the column is `sink_export`), so the one write it exists to protect failed
    // outright. Neutralizing it must go red, or a guard clause is back to being unchecked SQL.
    name: "R58 — the export-revision guard names the TypeScript field instead of the column",
    file: "packages/db/src/results/pg-scorecard-store.ts",
    from: "COALESCE((sink_export->>'scoringRevision')::int, 0)",
    to: "COALESCE((export->>'scoringRevision')::int, 0)",
    suite: ["--root", "packages/db", "src/results/export-guard-column.counterexample.test.ts"],
  },
  {
    // arch-review 57 P1-high. The managed lanes recorded the in-container driver's `NO_IMAGE` — true of that
    // driver, false of the run — so two executions of a moved tag compared as the same world. Neutralizing
    // the merge must go red, or provenance is back to describing the wrong layer.
    name: "R57 — a managed result keeps the inner driver's silence about its image",
    file: "packages/backends/src/orchestrators/placement-image.ts",
    from: "  if (ref === undefined || result.execution === undefined) return result;",
    to: "  if (true) return result;",
    suite: ["--root", "packages/backends", "src/orchestrators/placement-image.counterexample.test.ts"],
  },
  {
    // …and the half that makes the merge safe: the placement FILLS a gap, never overwrites. A driver that
    // really pulled the image knows more than a placement can infer.
    name: "R57 — the placement overwrites a driver that actually read the digest",
    file: "packages/backends/src/orchestrators/placement-image.ts",
    from: "  return { ...result, execution: withPlacementImage(result.execution, laneImageProvenance(ref, lane)) };",
    to: "  return { ...result, execution: { ...result.execution, imageProvenance: laneImageProvenance(ref, lane) } };",
    suite: ["--root", "packages/backends", "src/orchestrators/placement-image.counterexample.test.ts"],
  },
  {
    // The world proof is CHECKED, not trusted. Accepting a declared box on the strength of a proof nobody
    // verified is the same as running unenforced, with a receipt.
    name: "R57 — a host driver accepts a declared world without checking the proof",
    file: "packages/drivers/src/local.ts",
    from: "    const covered = worldProofCovers(this.opts.worldProof, spec.resources, spec.network);",
    to: "    const covered = true;",
    suite: ["--root", "packages/drivers", "src/local-world-proof.counterexample.test.ts"],
  },
  {
    // arch-review 57 P0. The retry used to rebuild an authority from the row it was about to drive, which is
    // how a displaced replica adopted its successor's generation. Neutralizing the fence must go red, or the
    // worklist is back to carrying identity that any live token can be attached to.
    name: "R57 — a deferred retry drives whatever generation the row now holds",
    file: "packages/application-control/src/ops/startup-recovery.ts",
    from: "      if (!stillHolds(target.authority, record)) continue;",
    to: "      // MUTATED: the successor's token is good enough",
    suite: ["--root", "packages/application-control", "src/ops/deferred-recovery-authority.counterexample.test.ts"],
  },
  {
    // …and the same for the verifier's own restore. A `git apply` whose exit code nobody reads means the
    // graders run over a pristine image and return that as the agent's verdict — a wrong number, which is
    // worse than the `unmeasured` an honest failure produces.
    name: "R57 — the verifier grades whatever the container held when the restore failed",
    file: "packages/job-runner/src/verifier-job.ts",
    from: "      if (applied.exitCode !== 0)",
    to: "      if (false)",
    suite: ["--root", "packages/job-runner", "src/verifier-job.real-driver.counterexample.test.ts"],
  },
  {
    name: "Wave A — the reservation moves back behind the effect",
    file: "packages/backends/src/orchestrators/k8s.ts",
    from: "    if (job.runId !== undefined) await requireReservation(job, work, options?.onReserved);",
    to: "    // MUTATED: identity after effect",
    suite: ["--root", "packages/backends", "src/orchestrators/dispatch-intent.counterexample.test.ts"],
  },
  {
    // The rung Wave A's own mutation cannot reach: with the ordering intact, accept a hook that resolved
    // without persisting anything. That is the state the whole phase exists to make unrepresentable — a
    // resolved callback standing in for a written row.
    name: "Phase 1 — a reservation that proved nothing is accepted",
    file: "packages/backends/src/backend.ts",
    from: '  if (!intent || typeof intent.attemptId !== "string" || intent.attemptId === "")',
    to: "  if (false)",
    suite: ["--root", "packages/backends", "src/orchestrators/managed-conformance.test.ts"],
  },
  {
    // …and the other half of the same protocol: a tracked run placed with nobody recording where.
    name: "Phase 1 — a tracked run is placed with no reservation hook at all",
    file: "packages/backends/src/backend.ts",
    from: "  if (!onReserved)",
    // Permissive, not merely disabled: simply removing the throw left `await onReserved(work)` to raise a
    // TypeError, which aborted the dispatch anyway and kept the suite green over a hole. A mutation has to
    // produce the DEFECT (a tracked run placed with nobody recording it), not a different failure.
    to: '  if (!onReserved) return { attemptId: "unrecorded", work, persistedAt: "1970-01-01T00:00:00.000Z" };\n  if (false)',
    suite: ["--root", "packages/backends", "src/orchestrators/managed-conformance.test.ts"],
  },
  {
    name: "Wave A.5 — an unreadable ledger widens the teardown again",
    file: "packages/application-control/src/run/run-service.ts",
    from: '    if (worksRead.kind === "unknown") {',
    to: '    if (false && worksRead.kind === "unknown") {',
    suite: ["--root", "apps/api", "src/core/run/unknown-propagation.counterexample.test.ts"],
    build: "@everdict/application-control",
  },
  {
    name: "legacy removal — a case-id control method comes back",
    file: "packages/backends/src/orchestrators/nomad.ts",
    from: "  async killWork(work: RuntimeWorkRef): Promise<KillOutcome> {",
    to: '  async kill(caseId: string): Promise<KillOutcome> {\n    void caseId;\n    return { status: "absent" };\n  }\n\n  async killWork(work: RuntimeWorkRef): Promise<KillOutcome> {',
    suite: ["--root", "packages/backends", "src/orchestrators/legacy-case-addressing-guard.test.ts"],
  },
  {
    // Phase 2's rung: with the union in place, collapse the third case back into the second and the caller
    // silently re-dispatches a job that may still be running.
    name: "Phase 2 — an unestablished adoption becomes an absence",
    file: "apps/api/src/composition/runtime-access.ts",
    // The CALLER's arm, which is what the counterexample drives (it injects its own adoptWorkFn, so the fold
    // above it never runs). Mutating the fold tested nothing — a mutation must target the line the suite
    // actually reaches.
    from: '            if (decision.kind === "unknown") return { kind: "retry_later", reason: decision.reason };',
    to: "            // MUTATED: an unestablished adoption is treated as an absence",
    suite: ["--root", "apps/api", "src/composition/adoption-unknown-recovery.counterexample.test.ts"],
  },
  {
    // …and the adapter half: a cluster that could not be asked reported as "the job is gone".
    name: "Phase 2 — a failed cluster listing reads as absence again",
    file: "packages/backends/src/orchestrators/nomad.ts",
    from: '      if (found.kind === "unknown") return { status: "unknown" };',
    to: "      // MUTATED: a failed read is an absence",
    suite: ["--root", "packages/backends", "src/orchestrators/adoption-unknown.counterexample.test.ts"],
  },
  {
    name: "Wave B — the exact placement read resolves by case id",
    file: "packages/backends/src/orchestrators/k8s.ts",
    from: '        placementOf(api, work.externalJobId, work.namespace ?? this.opts.namespace ?? "default"),',
    to: '        placementOf(api, (await newestJobForCase(api, "c1"))?.name ?? "", "everdict-acme"),',
    suite: ["--root", "packages/backends", "src/orchestrators/exact-work-control.counterexample.test.ts"],
  },
  {
    // Wave 3's rung: build the teardown's worklist from the children that still read as live, and the retry
    // forgets every handle whose kill failed while it terminalized the row that named it.
    name: "Wave 3 — the cancellation worklist comes from the rows again",
    file: "packages/application-control/src/scorecard/scorecard-service.ts",
    from: '    const placed = placedRead.kind === "read" ? placedRead.value : [];',
    to: "    const placed = [];",
    suite: ["--root", "apps/api", "src/core/scorecard/cancellation-work-debt.counterexample.test.ts"],
    build: "@everdict/application-control",
  },
  {
    // …and the enumeration half: a ledger this teardown could not read is not a batch that placed nothing.
    name: "Wave 3 — an unreadable ledger becomes an empty workset",
    file: "packages/application-control/src/scorecard/scorecard-service.ts",
    from: '    if (placedRead.kind === "unknown")',
    to: "    if (false)",
    suite: ["--root", "apps/api", "src/core/scorecard/cancellation-work-debt.counterexample.test.ts"],
    build: "@everdict/application-control",
  },
  {
    // Wave 4's rung: the finalize stops joining its receipts to the ledger row the settle conditions on, and
    // every receipt on the Temporal lane names an evidence plane that was never sealed.
    name: "Wave 4 — the judgment receipt drops its invocation ordinal",
    file: "packages/application-control/src/scorecard/workflow-batch-driver.ts",
    from: "      judgments: judgmentReceiptsFromPlane(results, initialScoringPassId(id), (r) =>\n        judgeClaimOfAttempt(receiptByKey.get(childKey(r.caseId, r.trial))?.attemptId),\n      ),",
    to: "      judgments: judgmentReceiptsFromPlane(results, initialScoringPassId(id)),",
    suite: ["--root", "packages/application-control", "src/scorecard/judgment-receipt-join.counterexample.test.ts"],
  },
  {
    // …and the other direction: an attempt with no recording generation has no ordinal to state, so a claim
    // fabricated here names a plane just as wrongly as omitting a real one.
    name: "Wave 4 — an absent attempt is given a fabricated ordinal",
    file: "packages/domain/src/scorecard/judge-execution-spans.ts",
    from: "  return generation === undefined ? undefined : { generation, attempt: 1 };",
    to: "  return { generation: generation ?? 0, attempt: 1 };",
    suite: ["--root", "packages/application-control", "src/scorecard/judgment-receipt-join.counterexample.test.ts"],
    build: "@everdict/domain",
  },
  {
    // Wave 5's rung, RE-POINTED in Wave 7: the effect that made the fold a wrong DECISION (the write-only
    // alias promotion) is deleted, so the mutation now has to break the projection the fold still reaches —
    // "we never established the order" collapsing into "I am the newest", which overwrites a newer receipt.
    // Deliberately `behind` and not `ahead`: `ahead` also skips the write, so mutating to it would leave the
    // suite green over a fold that is still wrong.
    name: "Wave 5 — an unknown settlement order becomes 'I am the newest'",
    file: "packages/application-control/src/scorecard/publication.ts",
    from: '  if (siblings.kind === "unknown") return "unknown";',
    to: '  if (siblings.kind === "unknown") return "behind";',
    suite: [
      "--root",
      "packages/application-control",
      "src/scorecard/publication-projection-unknown.counterexample.test.ts",
    ],
  },
  {
    // …and the half that says the export is still OWED when the order is unknown: withholding the effect
    // because the projection cannot be placed would be the opposite error, and just as invisible.
    name: "Wave 7 — an unknown settlement order withholds the owed export",
    file: "packages/application-control/src/scorecard/publication.ts",
    from: "  let exported: ScorecardExport | undefined;\n  for (const effect of operation.effects) {",
    to: '  let exported: ScorecardExport | undefined;\n  if ((await settlementPosition(deps, operation)) !== "behind")\n    return { kind: "failed", reason: "order unknown", owed: true };\n  for (const effect of operation.effects) {',
    suite: [
      "--root",
      "packages/application-control",
      "src/scorecard/publication-projection-unknown.counterexample.test.ts",
    ],
  },
  {
    // Wave 8's rung: the drain stops renewing while the export is in flight, so a slow upload makes the row
    // look abandoned and the sweep hands it to a second publisher mid-call.
    name: "Wave 8 — the publication lease is not renewed across the sink call",
    file: "packages/application-control/src/scorecard/publication.ts",
    from: "      void operations.renew(operation.id, owner, leaseSeconds, now()).then(",
    to: "      void Promise.resolve(false).then(",
    suite: ["--root", "packages/application-control", "src/scorecard/publication-lease-renewal.counterexample.test.ts"],
  },
  {
    // …and the ledger half: a renewal that does not check WHO is renewing is a second way to take the row,
    // which is precisely what the claim exists to prevent. Certified by the conformance suite, so a second
    // implementation inherits the question instead of having to remember it.
    name: "Wave 8 — a renewal may be performed by somebody who does not hold the claim",
    file: "packages/application-control/src/ports/publication-operation-store.ts",
    from: '    if (!current || current.claimedBy !== owner || current.state !== "claimed") return false;\n    this.operations.set(id, {\n      ...current,\n      leaseUntil:',
    to: "    if (!current) return false;\n    this.operations.set(id, {\n      ...current,\n      leaseUntil:",
    suite: ["--root", "packages/application-control", "src/scorecard/protocol-conformance.test.ts"],
  },
  {
    // Wave 9's rung: the settle swallows a payload-freeze failure again, so an object-store blip during a
    // settle becomes indistinguishable from a row planned before payload freezing existed.
    name: "Wave 9 — a failed payload freeze is swallowed into silence",
    file: "packages/application-control/src/scorecard/scorecard-observability.ts",
    // Re-pointed at the inline form (arch-review 57): the bytes now ride the operation instead of being
    // planned as bytes nobody holds, and the REASON rides with them. Swallowing it is still the defect —
    // "no store here" and "the store blipped" call for different actions.
    from: "      out.payload = inlineExportPayload(",
    to: "      const swallowed = inlineExportPayload(",
    suite: ["--root", "packages/application-control", "src/scorecard/frozen-payload-required.counterexample.test.ts"],
  },
  {
    // …and the planner half: a settlement that owes an export and never staged a payload is defaulted to the
    // weaker state instead of refused, which puts the escape hatch back one layer down wearing a name.
    name: "Wave 9 — an unanswered payload question is defaulted rather than refused",
    file: "packages/application-control/src/scorecard/publication.ts",
    from: "  if (input.exports && input.staged.payload === undefined)\n    throw new InternalError(",
    to: "  if (false)\n    throw new InternalError(",
    suite: ["--root", "packages/application-control", "src/scorecard/frozen-payload-required.counterexample.test.ts"],
  },
  {
    // Wave A's rung (arch-review 56): the parent-authority vocabulary goes back to the negated form, so a
    // cancelled or superseded batch may authorize new compute again.
    name: "R56 Wave A — the reservation guard excludes instead of allowing",
    file: "packages/application-control/src/ports/execution-attempt-store.ts",
    from: "if (!parent || !(OPEN_SCORECARD_STATUSES as readonly string[]).includes(parent.status)) return undefined;",
    to: 'if (!parent || parent.status === "succeeded" || parent.status === "failed") return undefined;',
    suite: [
      "--root",
      "packages/application-control",
      "src/execution/reservation-authority-vocabulary.counterexample.test.ts",
    ],
  },
  {
    // …and the SQL twin, which is the lane the review found and the lane no behavioural test can evaluate.
    name: "R56 Wave A — the SQL parent guard spells its own status list",
    file: "packages/db/src/results/pg-execution-attempt-store.ts",
    from: "                AND s.status IN (${OPEN_SCORECARDS})",
    to: "                AND s.status NOT IN ('succeeded', 'failed')",
    suite: [
      "--root",
      "packages/db",
      "src/results/pg-execution-attempt-store.test.ts",
      "src/negated-status-guard.test.ts",
    ],
  },
  {
    // R56 Wave C's rung: the deferral goes back to a counter, so nothing names what the sweep still owes and
    // the record sits claimed by a live replica with no driver.
    name: "R56 Wave C — a deferred recovery names no worklist",
    file: "packages/application-control/src/ops/startup-recovery.ts",
    from: '      owed.push({ kind: "scorecard", id: c.id, authority });',
    to: "",
    suite: ["--root", "packages/application-control", "src/ops/deferred-recovery-owner.counterexample.test.ts"],
  },
  {
    // …and the retry half: dropping a target that deferred AGAIN is the current defect with more steps.
    name: "R56 Wave C — a still-undecidable target is dropped from the worklist",
    file: "packages/application-control/src/ops/startup-recovery.ts",
    from: '      if (disposition.kind === "retry_later") stillOwed.push(target);\n      continue;',
    to: "      continue;",
    suite: ["--root", "packages/application-control", "src/ops/deferred-recovery-owner.counterexample.test.ts"],
  },
  {
    // R56 Wave D's rung: the idempotent path goes back to returning a stored intent without asking, so a
    // cancelled or superseded parent re-authorizes work its teardown already converged on.
    name: "R56 Wave D — a re-offered reservation skips its authority check",
    file: "packages/application-control/src/ports/execution-attempt-store.ts",
    from: "        await this.assertParentStillAuthorizes(attemptId, current);\n        return { attemptId, work: current.runtimeWork, persistedAt: current.updatedAt };",
    to: "        return { attemptId, work: current.runtimeWork, persistedAt: current.updatedAt };",
    suite: ["--root", "packages/application-control", "src/execution/reservation-lifetime.counterexample.test.ts"],
  },
  {
    // …and the SQL twin, where the shortcut was a bare `WHERE attempt_id = $1`.
    name: "R56 Wave D — the SQL idempotency read stops carrying the authority answer",
    file: "packages/db/src/results/pg-execution-attempt-store.ts",
    from: "        if (!held.authorized)",
    to: "        if (false)",
    suite: ["--root", "packages/db", "src/results/pg-execution-attempt-store.test.ts"],
  },
  {
    // R56 Wave E's rung: a lane judges with no pass scope again, so its evidence seals under a bare
    // `judge:<id>` while its revision's receipts name `judge:<id>#<passId>` — a plane nothing wrote.
    name: "R56 Wave E — a lane judges without naming its pass",
    file: "packages/application-control/src/scorecard/scorecard-ingest-service.ts",
    from: "      { passId: initialScoringPassId(id) },\n    ); // trace → judge scores (control plane)",
    to: "      undefined as never,\n    ); // trace → judge scores (control plane)",
    suite: ["--root", "packages/application-control", "src/scorecard/judgment-scope-parity.counterexample.test.ts"],
  },
  {
    // R56 Wave F's rung: the receipt write drops its condition, so it goes back to a read followed by an
    // unconditional update and an older settlement can land on a newer one's receipt.
    name: "R56 Wave F — the export projection is written unconditionally again",
    file: "packages/application-control/src/scorecard/publication.ts",
    from: "            expectExportRevisionBelow: operation.settlement.scoringRevision,",
    to: "",
    suite: [
      "--root",
      "packages/application-control",
      "src/scorecard/export-projection-monotonic.counterexample.test.ts",
    ],
  },
  {
    // R56 Wave G's rung: the teardown stops reading back, so an accepted delete converges the cancellation
    // while the container is still running through its grace period.
    name: "R56 Wave G — an accepted stop converges without an observed absence",
    file: "packages/application-control/src/scorecard/scorecard-service.ts",
    from: '      if (outcome?.status === "stopped" && this.deps.probeWork) {',
    to: "      if (false && this.deps.probeWork) {",
    suite: ["--root", "apps/api", "src/core/scorecard/cancellation-verified-absence.counterexample.test.ts"],
    build: "@everdict/application-control",
  },
  {
    // R56 Wave H's rung: the split stops recognising private material, so a task-format case would ship its hidden
    // tests to the agent again — with the difference that now nothing refuses it either.
    name: "R56 Wave H — the verifier split stops separating anything",
    file: "packages/domain/src/execution/verifier-plan.ts",
    from: "  const priv = graders.filter(decides);",
    to: "  const priv = [];",
    suite: ["--root", "packages/domain", "src/execution/verifier-plan.counterexample.test.ts"],
  },
  {
    // R56 Wave I's rung: the verifier job stops restoring the agent's work, so it reaches a verdict about an
    // empty checkout — a benchmark that scores every case the same and looks like it ran.
    name: "R56 Wave I — the verifier judges a workspace it never restored",
    file: "packages/job-runner/src/verifier-job.ts",
    from: '    if (job.workspace.diff !== "") {',
    to: "    if (false) {",
    suite: ["--root", "packages/job-runner", "src/verifier-job.counterexample.test.ts"],
  },
  {
    // R56 Wave K's rung: the split stops being applied at dispatch, so the agent's job carries the plan again
    // — and `caseJobPayload` refuses it, which is the regression this wave exists to close.
    name: "R56 Wave K — the dispatch stops splitting the case",
    file: "packages/application-control/src/execution/verifier-pass.ts",
    from: "  const result = await deps.dispatch({ ...job, evalCase: plan.remainder });",
    to: "  const result = await deps.dispatch(job);",
    suite: ["--root", "packages/application-control", "src/execution/verifier-pass.counterexample.test.ts"],
  },
  {
    // …and the half that keeps a failed verdict visible: dropping it leaves a CaseResult whose scores are the
    // observation-only ones, which reads as "graded, and it scored nothing".
    name: "R56 Wave K — an unreachable verdict is omitted instead of recorded",
    file: "packages/application-control/src/execution/verifier-pass.ts",
    // Re-pointed (arch-review 57): a lane now answers an INVOCATION rather than bare scores, so the failure
    // path records the same `unmeasured` from a different line. The defect is unchanged — dropping it leaves
    // a CaseResult whose scores are the observation-only ones, which reads as "graded, and it scored nothing".
    from: '    return owed("grader_error", invocation instanceof Error ? invocation.message : String(invocation));',
    to: "    return result;",
    suite: ["--root", "packages/application-control", "src/execution/verifier-pass.counterexample.test.ts"],
  },
  {
    name: "Wave C — the publication claim moves back below the effects",
    file: "packages/application-control/src/scorecard/publication.ts",
    // RE-ANCHORED (arch-review 55, Wave 8): the claim now reads from a local `operations` binding, because the
    // heartbeat closes over it. The runner refused the stale line rather than silently testing nothing.
    from: "  const claimed = await operations.claim(operation.id, owner, leaseSeconds, now());",
    to: "  const outcomeFirst = await performEffects(deps, record, operation, results);\n  void outcomeFirst;\n  const claimed = await operations.claim(operation.id, owner, leaseSeconds, now());",
    suite: ["--root", "packages/application-control", "src/scorecard/publication-operation.counterexample.test.ts"],
  },
  {
    // Phase 3, the identity half: read the whole suffix again and one judge becomes one per criterion.
    name: "Phase 3 — a criterion metric is read as its own judge",
    file: "packages/domain/src/scorecard/judge-execution-spans.ts",
    from: '  const colon = rest.indexOf(":");',
    to: "  const colon = -1;",
    suite: ["--root", "packages/domain", "src/scorecard/judgment-coverage.counterexample.test.ts"],
  },
  {
    // …and the coverage half: let presence stand in for authorship again.
    name: "Phase 3 — an empty receipt vector counts as complete provenance",
    file: "packages/domain/src/scorecard/scoring-revision.ts",
    from: "              complete: input.judgments.length >= expectedJudgmentUnits(input),",
    to: "              complete: true,",
    suite: ["--root", "packages/domain", "src/scorecard/judgment-coverage.counterexample.test.ts"],
  },
  {
    name: "Wave D — the gate stops asking who judged",
    file: "packages/domain/src/scorecard/gate.ts",
    from: "    if (pin !== undefined && !vouched && policy.allowUnrecordedJudgments !== true)",
    to: "    if (false && pin !== undefined && !vouched && policy.allowUnrecordedJudgments !== true)",
    suite: ["--root", "packages/domain", "src/scorecard/judgment-provenance.counterexample.test.ts"],
  },
  {
    // Phase 4: read the record's live plane again instead of the bytes the settlement froze.
    name: "Phase 4 — the export re-reads the record instead of its frozen payload",
    file: "packages/application-control/src/scorecard/publication.ts",
    from: "      payload = frozen as CaseResult[];",
    to: "      // MUTATED: ship whatever the record holds now",
    suite: [
      "--root",
      "packages/application-control",
      "src/scorecard/publication-frozen-payload.counterexample.test.ts",
    ],
  },
  {
    // …and the projection half: let a late drain move `current` backwards.
    name: "Phase 4 — an older settlement can overwrite the newer one's projection",
    file: "packages/application-control/src/scorecard/publication.ts",
    // RE-ANCHORED (arch-review 55, Wave 5): the predicate became `aliasPosition` when its answer went
    // three-valued, and the runner refused the stale line rather than silently testing nothing.
    from: '  if (!operations) return "behind"; // single-publisher deployment: no second settlement can race this one',
    to: '  return "behind";',
    suite: [
      "--root",
      "packages/application-control",
      "src/scorecard/publication-frozen-payload.counterexample.test.ts",
    ],
  },
  {
    // …and the sink half: mint fresh ids per attempt, so a retried export duplicates on the platform.
    name: "Phase 4 — a retried export cannot be deduped by the sink",
    file: "packages/trace/src/sinks/langfuse-sink.ts",
    from: "    const newId = ctx.idempotencyKey ? seededIds(ctx.idempotencyKey) : this.newId;",
    to: "    const newId = this.newId;",
    suite: ["--root", "packages/trace", "src/sinks/idempotent-export.test.ts"],
  },
  {
    name: "Phase 5 — the reconciler converges on its own protocol again",
    file: "packages/application-control/src/cancellation/cancellation-coordinator.ts",
    from: "        await runDurableTeardown(",
    to: "        await (async () => teardown(operation.target.id))(); await (async () => {})(",
    suite: ["--root", "packages/application-control", "src/cancellation/reconciler-protocol.counterexample.test.ts"],
  },
  {
    name: "Phase 5 — a spent budget closes the operation instead of escalating it",
    file: "packages/application-control/src/ports/cancellation-store.ts",
    from: '      state: "verifying",\n      lastError: reason,',
    to: '      state: "completed",\n      lastError: reason,',
    suite: ["--root", "packages/application-control", "src/cancellation/reconciler-protocol.counterexample.test.ts"],
  },
  {
    name: "Wave E — every teardown failure records as merely requested",
    file: "packages/application-control/src/cancellation/cancellation-coordinator.ts",
    from: '    const reached: "requested" | "verifying" = detail?.unverifiable !== undefined ? "verifying" : "requested";',
    to: '    const reached: "requested" | "verifying" = "requested";',
    suite: ["--root", "packages/application-control", "src/cancellation/verified-completion.counterexample.test.ts"],
  },
  {
    // A declared world that is silently ignored: the case asked for 2 CPUs and an offline box, the driver
    // gives it whatever the host has and full internet, and the score is filed as if the declaration held.
    name: "declared world — the case's resources/network are dropped by the driver",
    file: "packages/drivers/src/docker.ts",
    from: "export function dockerWorldArgs(spec: ComputeSpec, label: string): string[] {",
    to: "export function dockerWorldArgs(spec: ComputeSpec, label: string): string[] {\n  void spec;\n  void label;\n  return [];",
    suite: ["--root", "packages/drivers", "src/declared-world.test.ts"],
  },
  {
    // …and the hop before it: the declaration never reaches the thing that enforces it, which fails exactly
    // like a case that declared nothing — the drivers' own tests build the ComputeSpec themselves and
    // cannot see this.
    name: "declared world — the declaration is dropped on the way to the driver",
    file: "packages/application-execution/src/run-case.ts",
    from: "    ...(evalCase.resources ? { resources: evalCase.resources } : {}),",
    to: "",
    suite: ["--root", "packages/application-execution", "src/run-case.test.ts"],
  },
  {
    // The world a case RAN IN, not the one it asked for. The mutation does not merely disable the read — it
    // produces the defect: a container launched from a real image reports that it provisioned none, which
    // is the (a)/(c) collapse one optional field used to make invisible.
    name: "world provenance — the driver stops reading back the bytes it launched",
    file: "packages/drivers/src/docker.ts",
    from: "  const requested = parseImageRef(ref).digest;",
    to: "  return NO_IMAGE;\n  const requested = parseImageRef(ref).digest;",
    suite: ["--root", "packages/drivers", "src/image-provenance.counterexample.test.ts"],
  },
  {
    // …and the hop after it: the driver's answer never reaches the manifest, which fails exactly like a
    // driver that never read it — the drivers' tests build the handle themselves and cannot see this.
    name: "world provenance — the manifest records the request instead of the driver's answer",
    file: "packages/application-execution/src/run-case.ts",
    from: "        imageProvenance: compute.image,",
    to: "        ...(evalCase.image !== undefined ? { image: evalCase.image } : {}),",
    suite: ["--root", "packages/application-execution", "src/image-provenance-hop.counterexample.test.ts"],
  },
  {
    // The reader's era rule, neutralized into the collapse it exists to prevent: a manifest from before
    // provenance reads as a world that ran NO image, so every legacy batch claims it provisioned nothing
    // instead of admitting nobody recorded what it ran.
    name: "world provenance — a legacy manifest is read as a world that ran no image",
    file: "packages/domain/src/image/image-provenance.ts",
    from: '    const ref = manifest.image ?? "";',
    to: '    return { kind: "none" };\n    const ref = manifest.image ?? "";',
    suite: ["--root", "packages/domain", "src/image/image-provenance.test.ts"],
    build: "@everdict/domain",
  },
];

const files = [...new Set(MUTATIONS.map((m) => m.file))];
// `git diff HEAD`, not `status --porcelain`: the latter also compares the worktree to the INDEX, and in a
// tree several sessions commit into through temp indexes the real one lags behind the ref — so files whose
// CONTENT is exactly HEAD's get reported as modified and this refuses to run. The question here is only
// whether the checkout differs from the commit, because that is what "restore the exact original" means.
const dirty = execFileSync("git", ["diff", "HEAD", "--name-only", "--", ...files], { encoding: "utf8" }).trim();
if (dirty !== "") {
  console.error(`✖ protocol mutations: the files under mutation have uncommitted changes:\n${dirty}`);
  console.error("  Commit or stash them first — a mutation run must be able to restore the exact original.");
  process.exit(2);
}

let holes = 0;
for (const mutation of MUTATIONS) {
  const original = readFileSync(mutation.file, "utf8");
  if (!original.includes(mutation.from)) {
    console.error(`✖ ${mutation.name}: the line to mutate is gone from ${mutation.file}`);
    console.error("  A mutation that matches nothing tests nothing — update it to the code as it is now.");
    holes += 1;
    continue;
  }
  try {
    writeFileSync(mutation.file, original.replace(mutation.from, mutation.to));
    if (mutation.build) spawnSync("pnpm", ["-F", mutation.build, "build"], { stdio: "ignore" });
    const run = spawnSync("npx", ["vitest", "run", ...mutation.suite], { stdio: "ignore" });
    if (run.status === 0) {
      console.error(`✖ HOLE — ${mutation.name}: the suite stayed GREEN with the protocol removed.`);
      holes += 1;
    } else {
      console.log(`✓ ${mutation.name} — the suite went red, as it must`);
    }
  } finally {
    writeFileSync(mutation.file, original);
    if (mutation.build) spawnSync("pnpm", ["-F", mutation.build, "build"], { stdio: "ignore" });
  }
}

if (holes > 0) {
  console.error(`\n✖ ${holes} protocol(s) are not actually enforced by the suite that claims to enforce them.`);
  process.exit(1);
}
console.log(`\n✓ every protocol mutation was caught (${MUTATIONS.length} checked)`);
