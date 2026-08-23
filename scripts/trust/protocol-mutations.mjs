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
    // arch-review 59 P0. A dispatch that reserved and ACTIVATED has passed its last check; probing it now
    // answers absent, truthfully, and that counted as convergence — so the certificate said zero and the
    // paused submitter then created the job. Dropping the read-back must go red.
    name: "R59 — a cancellation certifies zero while a dispatch is authorized to create work",
    file: "packages/application-control/src/scorecard/scorecard-service.ts",
    from: '      const activeBirths = unborn.filter((a) => a.state === "active");',
    to: "      const activeBirths: typeof pending.value = [];",
    build: "@everdict/application-control",
    suite: ["--root", "apps/api", "src/core/scorecard/authorized-submitter.counterexample.test.ts"],
  },
  {
    // arch-review 59 P0-verifier. `PARENT_AUTHORIZES` compares the parent's epoch only when the attempt has
    // one, so a verifier row opened without it satisfies the predicate under ANY owner — a displaced replica
    // could still reserve and burn tenant compute. Dropping the coordinate must go red.
    name: "R59 — a verifier attempt is opened with no parent epoch",
    file: "packages/application-control/src/execution/verifier-operation.ts",
    from: "    ...(job.driverEpoch !== undefined ? { driverEpoch: job.driverEpoch } : {}),",
    to: "",
    suite: ["--root", "packages/application-control", "src/execution/verifier-parent-authority.counterexample.test.ts"],
  },
  {
    // arch-review 59 P0-lifecycle. The periodic sweep was wired to the LAST LINE of boot's recovery
    // transition, so a run deferred because the cluster would not say whether its job was live came back and
    // skipped the question — re-dispatching compute that was still running.
    name: "R59 — the periodic recovery skips the adoption phase",
    file: "apps/api/src/composition/runtime-access.ts",
    from: "      resumeRun: (r, authority) => recoverStandaloneRun(deps, r, authority),",
    to: "      resumeRun: (r, authority) => deps.service.resume(r, undefined, authority),",
    suite: ["--root", "apps/api", "src/composition/recovery-adoption-phase.counterexample.test.ts"],
  },
  {
    // arch-review 59 P0-world. The manifest and the proof were two expressions, so the Nomad lane requested no
    // GPU for a case that declared one and attested `gpu: 1` anyway — a false world, which `worldProofCovers`
    // ACCEPTS. Splitting them again must go red.
    name: "R59 — the Nomad proof is a copy of the request rather than of the effect",
    file: "packages/backends/src/orchestrators/nomad.ts",
    from: "  const gpu = job.evalCase.resources?.gpu ?? harness?.gpu ?? opts.gpu;",
    to: "  const gpu = harness?.gpu ?? opts.gpu;",
    suite: ["--root", "packages/backends", "src/orchestrators/nomad-world-proof.counterexample.test.ts"],
  },
  {
    // arch-review 59 P0-verifier. `dispatchVerifier` is the shared protocol written out longhand, and the copy
    // lost the activation the common path gained. Removing it again must go red.
    name: "R59 — the k8s verifier creates its Job without re-presenting the reservation",
    file: "packages/backends/src/orchestrators/k8s.ts",
    from: "      await requireActivation(verifierCaseJob(job), work, hooks?.authority);",
    to: "",
    suite: ["--root", "packages/backends", "src/orchestrators/verifier-activation.counterexample.test.ts"],
  },
  {
    // arch-review 59 P0-security. The backend put the judge's provider key into the pod/task environment, so
    // the job-runner held it and `LocalDriver` handed it to the agent under test. Injecting it again must go
    // red — the credential must not be in the environment the agent inherits.
    name: "R59 — the judge's key is injected into the agent's environment again",
    file: "packages/backends/src/orchestrators/nomad.ts",
    from: "    ...judgeEnv(job.judge), // per-run judge model config. The inline judge grader judges with this model.",
    to: "    ...judgeEnv(job.judge),\n    ...judgeAuthEnv(job.judge, job.judgeAuth),",
    suite: ["--root", "packages/backends", "src/orchestrators/managed-judge-key.counterexample.test.ts"],
  },
  {
    // arch-review 59 P1-high. K8s applied a deny-all egress policy and the proof did not learn the axis, so
    // the in-container check refused every offline case the lane had just enforced. Dropping the claim again
    // must go red.
    name: "R59 — the k8s lane enforces a network world it does not attest",
    file: "packages/backends/src/orchestrators/placement-image.ts",
    from: "      ...(claimsNetwork ? { network } : {}),",
    to: "",
    suite: ["--root", "packages/backends", "src/orchestrators/k8s-network-policy.counterexample.test.ts"],
  },
  {
    // arch-review 58 W5 follow-through. A deny-all egress policy that selected `app: everdict` would cut off
    // every other job in the namespace; one that selected nothing would enforce nothing. The per-unit label
    // is the whole difference, and widening it must go red.
    name: "R58 W5 — the egress policy selects the whole app instead of this unit",
    file: "packages/backends/src/orchestrators/k8s-network-policy.ts",
    from: "      podSelector: { matchLabels: { [UNIT_LABEL]: unit } },",
    to: '      podSelector: { matchLabels: { app: "everdict" } },',
    suite: ["--root", "packages/backends", "src/orchestrators/k8s-network-policy.counterexample.test.ts"],
  },
  {
    // …and the lifetime: `ttlSecondsAfterFinished` deletes the Job and knows nothing about a policy beside
    // it, so without an owner reference the policy outlives every case that ever declared one.
    name: "R58 W5 — the egress policy outlives the Job it was written for",
    file: "packages/backends/src/orchestrators/k8s-network-policy.ts",
    from: '        { apiVersion: "batch/v1", kind: "Job", name: jobName, uid, controller: false, blockOwnerDeletion: false },',
    to: '        { apiVersion: "batch/v1", kind: "Pod", name: jobName, uid, controller: false, blockOwnerDeletion: false },',
    suite: ["--root", "packages/backends", "src/orchestrators/k8s-network-policy.counterexample.test.ts"],
  },
  {
    // arch-review 58 W4. `retry_later` always carried a reason and every consumer dropped it, so a debt
    // could sit in the worklist forever with nothing saying why. Removing the escalation must go red.
    name: "R58 W4 — an undecidable debt is held in silence again",
    file: "apps/api/src/composition/runtime-access.ts",
    from: "        if (t.attempts >= ESCALATE_AFTER_ATTEMPTS)",
    to: "        if (false)",
    suite: ["--root", "apps/api", "src/composition/deferred-recovery-sweep.counterexample.test.ts"],
  },
  {
    // arch-review 58 W5. A network declaration nothing on the way enforces was refused inside the container
    // the lane had already placed — right decision, wrong moment, after a reservation and an activation had
    // been spent. Removing the entry guard must go red on the ORDERING, not just on the refusal.
    name: "R58 W5 — an unenforceable network is refused only after the reservation",
    file: "packages/backends/src/orchestrators/nomad.ts",
    from: '      refuseUnenforceableNetwork(job.evalCase.network, "nomad");',
    to: "      void job;",
    suite: ["--root", "packages/backends", "src/orchestrators/network-declaration.counterexample.test.ts"],
  },
  {
    // arch-review 58 W1. The judge's provider key was applied by wrapping the DRIVER, so it rode every exec
    // through the compute the harness and the graders share — putting the tenant's credential in the
    // environment of the code being evaluated. Widening it back must go red.
    name: "R58 W1 — the judge's key rides the agent's execs again",
    file: "packages/application-execution/src/run-case.ts",
    // Aimed at the seam that hands the AGENT its compute. Wrapping the provision call would have left an
    // unbalanced paren, and a mutation that produces a syntax error tests the parser rather than the
    // protocol — the suite would go red for the wrong reason and prove nothing.
    from: "    await deps.harness.install(compute);",
    to: "    await deps.harness.install(forGrading(compute, deps.graderEnv));",
    suite: ["--root", "packages/application-execution", "src/grader-env-isolation.counterexample.test.ts"],
  },
  {
    // arch-review 58 W2. The Scheduler forwards dispatch options by an explicit allowlist whose own comment
    // says it is "the ONE place a hook can silently die" — and `onActivate` died in exactly it, so the
    // activation transition never ran on any SaaS dispatch. Forwarding half the authority must go red.
    name: "R58 W2 — the scheduler forwards half the dispatch authority",
    file: "packages/backends/src/scheduling/scheduler.ts",
    from: "            ...(entry.authority ? { authority: entry.authority } : {}),",
    to: "            ...(entry.authority ? { authority: { reserve: entry.authority.reserve } } : {}),",
    suite: ["--root", "packages/backends", "src/scheduling/dispatch-authority.counterexample.test.ts"],
  },
  {
    // …and the batch lane, which had no activation at all until the merge forced a supplier to answer both.
    name: "R58 W2 — the batch lane creates its container without re-proving the reservation",
    file: "packages/application-control/src/scorecard/in-process-batch-driver.ts",
    // The line goes ENTIRELY, and the suite asserts the supplier reaches `commit.activateWork`. The first
    // draft substituted a literal `activate: async () => ({kind:"activate"})`, which still contains the token
    // a source read looks for — a mutation that leaves the asserted-on thing in place is not a mutation, and
    // the runner said so before a human did.
    from: "            activate: (work: RuntimeWorkRef) => this.commit.activateWork(work),",
    to: "",
    suite: ["--root", "packages/application-control", "src/scorecard/temporal-work-handle.counterexample.test.ts"],
  },
  {
    // arch-review 58 follow-through. The managed lanes handed the agent under test the workspace's WHOLE
    // secret tier — GitHub App token, Mattermost bot token, registry passwords — because a default outlived
    // the per-job channels that replaced it. Spreading the tier back in must go red.
    // Aimed at each LANE, not at the shared filter in contracts: `packages/backends` resolves contracts
    // through its built `dist`, so mutating another package's `src` is invisible to the suite — the same
    // cross-package blind spot this runner caught twice in this wave. Two lanes, two entries, because the
    // property is precisely that a tenant's exposure does not depend on which one placed the job.
    name: "R58 — the nomad lane hands over the whole workspace secret tier",
    file: "packages/backends/src/orchestrators/nomad.ts",
    from: "    ...evalContainerSecretEnv(opts.secretEnv),",
    to: "    ...opts.secretEnv,",
    suite: ["--root", "packages/backends", "src/orchestrators/eval-container-secrets.counterexample.test.ts"],
  },
  {
    name: "R58 — the k8s lane hands over the whole workspace secret tier",
    file: "packages/backends/src/orchestrators/k8s.ts",
    from: "    ...evalContainerSecretEnv(opts.secretEnv),",
    to: "    ...opts.secretEnv,",
    suite: ["--root", "packages/backends", "src/orchestrators/eval-container-secrets.counterexample.test.ts"],
  },
  {
    // arch-review 58 follow-through. A judge's evidence seal is best-effort BY CONTRACT and its failure was
    // SILENT, so a judgment whose account is gone read exactly like one whose account is on file. Swallowing
    // the outcome again must go red. Re-aimed by arch-review 59, which replaced the assignment with the
    // union the store's own answer is read into — the failure arm is the same claim, one expression over.
    name: "R58 — a lost judge evidence seal is silent again",
    file: "apps/api/src/core/execution/judge-runner.ts",
    from: '          status: "unsealed",',
    to: '          status: "sealed" as never,',
    suite: ["--root", "apps/api", "src/core/execution/judge-seal-outcome.counterexample.test.ts"],
  },
  {
    // …and the reader half: the case's judgment plane is what turns that answer into something visible.
    name: "R58 — an unsealed judgment reads as complete",
    file: "packages/domain/src/scorecard/evidence-status.ts",
    from: '  if (result.judgmentsSealed === false) return "partial";',
    to: "",
    suite: ["--root", "packages/domain", "src/scorecard/judgment-evidence.counterexample.test.ts"],
  },
  {
    // arch-review 58 follow-through. `sameResolvedImages` and `VerifierReceipt.complete` were built by two
    // waves and consumed by nobody. The world axis is their consumer, and the gate refuses on it — so a
    // comparison whose two sides ran different image bytes can no longer pass as a clean green.
    name: "R58 — the world a comparison ran in stops being an identity axis",
    file: "packages/domain/src/scorecard/experiment-identity.ts",
    from: "  const world = worldAxis(results.baseline, results.candidate);",
    to: "  const world = undefined;",
    suite: ["--root", "packages/domain", "src/scorecard/world-axis.counterexample.test.ts"],
  },
  {
    // …and the half that keeps it honest: a side that cannot pin its bytes is UNVERIFIED, never held. An
    // axis that answered "held" on ignorance would be worse than no axis, because a gate would trust it.
    name: "R58 — an unpinnable world is read as the same world",
    file: "packages/domain/src/scorecard/experiment-identity.ts",
    from: '    if (bp.kind !== "resolved" || cp.kind !== "resolved")',
    to: "    if (false)",
    suite: ["--root", "packages/domain", "src/scorecard/world-axis.counterexample.test.ts"],
  },
  {
    // arch-review 58 P1. `complete` asked whether `imageProvenance` was SET, and the union is three-valued
    // precisely because that is not the same question: `none` and `unresolved` both counted as complete, so
    // the one signal for "this verdict is not fully attributed" said yes for the two cases it exists to flag.
    name: "R58 — a receipt calls unresolved provenance complete",
    file: "packages/domain/src/execution/verifier-receipt.ts",
    from: [
      "      invocation.work?.attemptId !== undefined &&",
      "      invocation.work.verifier !== undefined &&",
      '      invocation.imageProvenance?.kind === "resolved",',
    ].join("\n"),
    to: "      invocation.work !== undefined &&",
    suite: ["--root", "packages/domain", "src/execution/verifier-receipt-completeness.counterexample.test.ts"],
  },
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
    from: "          activate: (work) => this.activateWork(id, work),",
    to: '          activate: async () => ({ kind: "activate" }),',
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
    from: "    if (job.runId !== undefined) await requireReservation(job, work, options?.authority);",
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
    from: "  if (!authority)",
    // Permissive, not merely disabled: simply removing the throw left `await onReserved(work)` to raise a
    // TypeError, which aborted the dispatch anyway and kept the suite green over a hole. A mutation has to
    // produce the DEFECT (a tracked run placed with nobody recording it), not a different failure.
    to: '  if (!authority) return { attemptId: "unrecorded", work, persistedAt: "1970-01-01T00:00:00.000Z" };\n  if (false)',
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
    from: '      if (decision.kind === "unknown") return { kind: "retry_later", reason: decision.reason };',
    to: "      // MUTATED: an unestablished adoption is treated as an absence",
    suite: ["--root", "apps/api", "src/composition/adoption-unknown-recovery.counterexample.test.ts"],
  },
  {
    // …and the adapter half: a cluster that could not be asked reported as "the job is gone".
    //
    // RE-AIMED (arch-review 62). The lane grew a SECOND unreadable-cluster arm — the birth-phase read — and
    // it answers `unknown` for the same outage, so removing the listing's arm alone left the protocol
    // enforced by its neighbour and this mutation went green over a defect it could no longer create.
    // Defence in depth is good and it means no single line IS the protocol any more: the neutralization has
    // to remove every arm that reaches the same answer, or it is testing the line next to the one it names.
    name: "Phase 2 — a failed cluster listing reads as absence again",
    file: "packages/backends/src/orchestrators/nomad.ts",
    from: [
      '      if (found.kind === "unknown") return { status: "unknown" };',
      '      if (found.kind === "absent") return { status: "absent" };',
      "      // \u2500\u2500 A REGISTRATION STILL IN ITS BIRTH PHASE IS RECLAIMED, NOT AWAITED (arch-review 62 P0) \u2500\u2500\u2500\u2500\u2500\u2500",
      "      //",
      "      // This lane registers at `Count: 0` first so a cancellation always has an object to address, and only",
      "      // an authorized dispatch scales it to one. A crash in between leaves a job that Nomad will never",
      "      // schedule an allocation for \u2014 and `waitForAlloc` below is a poll for exactly that allocation, so it",
      "      // ran out and the run deferred forever on every boot. The K8s half of this is `suspend: true`.",
      "      const phase = await this.jobBirthPhase(work.externalJobId, ns);",
      '      if (phase.kind === "unknown") return { status: "unknown" };',
    ].join("\n"),
    to: [
      '      if (found.kind === "absent") return { status: "absent" };',
      "      const phase = await this.jobBirthPhase(work.externalJobId, ns);",
    ].join("\n"),
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
    from: '      owed.push({\n        kind: "scorecard",',
    to: '      if (false)\n      owed.push({\n        kind: "scorecard",',
    suite: ["--root", "packages/application-control", "src/ops/deferred-recovery-owner.counterexample.test.ts"],
  },
  {
    // …and the retry half: dropping a target that deferred AGAIN is the current defect with more steps.
    name: "R56 Wave C — a still-undecidable target is dropped from the worklist",
    file: "packages/application-control/src/ops/startup-recovery.ts",
    from: "        stillOwed.push({ ...target, attempts: target.attempts + 1, lastReason: disposition.reason });",
    to: "        void target;",
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
  {
    // arch-review 59 P1-security. The digest appended to a truncated label, back to the 32 bits whose own
    // comment called it "collision-free at any batch size we place" — a birthday bound, not a guarantee, on
    // the selector a sibling sweep KILLS by.
    name: "label identity — a destructive selector spends a 32-bit digest",
    file: "packages/backends/src/orchestrators/k8s.ts",
    from: "const LABEL_DIGEST_LEN = 32;",
    to: "const LABEL_DIGEST_LEN = 8;",
    suite: ["--root", "packages/backends", "src/orchestrators/destructive-identity.counterexample.test.ts"],
  },
  {
    // arch-review 59 P1-security, re-aimed by 60 P1-ops. The pull Secret named by one constant again, so two
    // dispatches holding different grants for a host overwrite each other's object and a pod pulls under a
    // credential it was never granted. The name moved from a content digest to the WORK when the lifetime
    // half was closed — the topology lane keeps the content-addressed form on purpose, so mutating THAT
    // symbol would neutralize a protocol this suite does not own.
    name: "registry auth — one Secret name for every dispatch",
    file: "packages/backends/src/orchestrators/k8s.ts",
    from: "  return `${jobName}-pull`;",
    to: '  return "everdict-registry-auth";',
    suite: ["--root", "packages/backends", "src/orchestrators/destructive-identity.counterexample.test.ts"],
  },
  {
    // arch-review 59 P1-high. The judging half placed with egress open while the agent was placed offline —
    // in the one container the hidden tests execute and the reward is computed in.
    name: "verifier world — the judging half is placed with the network open",
    file: "packages/backends/src/orchestrators/k8s.ts",
    from: "      const netPolicy = k8sNetworkPolicyFor(name, job.network);",
    to: "      const netPolicy = undefined;",
    suite: ["--root", "packages/backends", "src/orchestrators/verifier-network.counterexample.test.ts"],
  },
  {
    // The other half: the declared network not reaching the placement, so the lane's own enforce-or-refuse
    // decision is made against a world nobody declared and reads it as "no constraint".
    name: "verifier world — the declared network does not reach the placement",
    file: "packages/backends/src/orchestrators/verifier-placement.ts",
    from: "      ...(job.network !== undefined ? { network: job.network } : {}),",
    to: "",
    suite: ["--root", "packages/backends", "src/orchestrators/verifier-network.counterexample.test.ts"],
  },
  {
    // arch-review 59 P1-high. The verifier's compute placed with no admission, so a batch's fan-out doubled a
    // workspace's container count with nothing to 402 against.
    name: "verifier admission — a second container per case, admitted by nobody",
    file: "apps/api/src/composition/runtime-access.ts",
    from: "    admitVerifierCompute?.admit(job.tenant);",
    to: "",
    suite: ["--root", "apps/api", "src/composition/verifier-admission.counterexample.test.ts"],
  },
  {
    // arch-review 59 P1. The verifier's answer adopted without asking which unit it was about, so a previous
    // case's sentinel still in the logs became this case's verdict — with the request's own digests stamped
    // on it as provenance.
    name: "verifier identity — an answer about another unit is adopted as this case's verdict",
    file: "packages/contracts/src/execution/verifier-result-wire.ts",
    from: "  if (mismatched.length > 0)",
    to: "  if (false)",
    suite: ["--root", "packages/contracts", "src/execution/verifier-result-wire.counterexample.test.ts"],
  },
  {
    // arch-review 59 P1-high. The execution_world axis back to comparing image bytes alone, so two sides could
    // hold it while one ran with a GPU and the other without, or one offline and one online.
    name: "experiment identity — the world axis compares only the image",
    file: "packages/domain/src/scorecard/experiment-identity.ts",
    from: "      if (!sameEnforcedWorld(bw, cw)) differences.push(b.caseId);",
    to: "",
    suite: ["--root", "packages/domain", "src/scorecard/enforced-world-axis.counterexample.test.ts"],
  },
  {
    // arch-review 59 P1. Adoption back to one document, so a verifier's handle — which sits in the same list
    // a run's boot recovery enumerates — throws, and the whole run answers retry_later on every boot.
    name: "adoption — every container is assumed to print the case wire",
    file: "packages/contracts/src/execution/adopted-result.ts",
    from: '  if (work.verifier === undefined) return { stage: "case", result: parseResult(stdout) };',
    to: '  return { stage: "case", result: parseResult(stdout) };',
    suite: ["--root", "packages/contracts", "src/execution/verifier-adoption.counterexample.test.ts"],
  },
  {
    // arch-review 59 P1, producer half. `created` discarded again, so a seal that stored nothing because an
    // earlier segment already held this emitter reports as this execution's own evidence.
    name: "judgment evidence — an earlier execution's account is reported as this judgment's",
    file: "apps/api/src/core/execution/judge-runner.ts",
    from: '        status: meta.created ? "sealed" : "superseded",',
    to: '        status: "sealed",',
    suite: ["--root", "apps/api", "src/core/execution/judge-seal-outcome.counterexample.test.ts"],
  },
  {
    // …and the consumer half, which stayed green under the producer's own mutation until it had a test: the
    // case keeps vouching that every judgment can be re-read while one judgment's account is somebody else's.
    name: "judgment evidence — the vouch survives evidence that is not this execution's",
    file: "packages/application-control/src/execution/scoring-service.ts",
    from: '      if (invocation.evidence.status === "unsealed" || invocation.evidence.status === "superseded")',
    to: '      if (invocation.evidence.status === "unsealed")',
    suite: [
      "--root",
      "packages/application-control",
      "src/execution/judgment-evidence-ownership.counterexample.test.ts",
    ],
  },
  {
    // arch-review 59. The activation lease removed, so a submitter that died between being told yes and its
    // submit leaves the cancellation owed for the life of the deployment.
    name: "activation lease — an abandoned authorization is waited on forever",
    file: "packages/application-control/src/scorecard/scorecard-service.ts",
    from: "      const abandoned = activeBirths.filter((a) => at - Date.parse(a.updatedAt) >= ACTIVATION_LEASE_MS);",
    to: "      const abandoned: typeof activeBirths = [];",
    suite: ["--root", "apps/api", "src/core/scorecard/authorized-submitter.counterexample.test.ts"],
    build: "@everdict/application-control",
  },
  {
    // …and the other direction, which is the one that would be worse than the defect: the lease ignored, so a
    // submitter milliseconds from creating its object is revoked on a probe that is not yet authoritative.
    name: "activation lease — a live submitter is revoked inside its own window",
    file: "packages/application-control/src/scorecard/scorecard-service.ts",
    from: "at - Date.parse(a.updatedAt) >= ACTIVATION_LEASE_MS",
    to: "true",
    suite: ["--root", "apps/api", "src/core/scorecard/authorized-submitter.counterexample.test.ts"],
    build: "@everdict/application-control",
  },
  {
    // arch-review 59 follow-through. The default ServiceAccount token back in every eval/topology pod, i.e. a
    // bearer credential for our cluster API inside a container running the tenant's own untrusted code.
    name: "pod identity — an untrusted pod mounts a token for our cluster API",
    file: "packages/domain/src/runtime/trust-zone-hardening.ts",
    from: "export const UNTRUSTED_POD_IDENTITY = { automountServiceAccountToken: false } as const;",
    to: "export const UNTRUSTED_POD_IDENTITY = {} as { automountServiceAccountToken?: false };",
    suite: ["--root", "packages/topology", "src/untrusted-pod-identity.counterexample.test.ts"],
    build: "@everdict/domain",
  },
  {
    // arch-review 59 follow-through. The job payload back in the agent's container environment, where
    // `/proc/<pid>/environ` hands it to the thing being measured — repo token, registry passwords, the
    // resolved judge key, and the grading configuration, which in an evaluation product is the answer key.
    name: "payload transport — the agent's container is exec'd with the job payload",
    file: "packages/backends/src/orchestrators/k8s.ts",
    from: "    [JOB_PAYLOAD_FILE_ENV[payload.kind]]: payloadPath,",
    to: "    EVERDICT_CASE_JOB: payload.value,",
    suite: ["--root", "packages/backends", "src/orchestrators/payload-not-in-agent-env.counterexample.test.ts"],
  },
  {
    // …and the runner half, back to the pre-arch-review-60 order: read the bytes, then unlink with the
    // failure swallowed. A read that succeeded and an unlink that failed then hands the payload on and leaves
    // it exactly where the agent can reach it.
    //
    // This entry INHERITS arch-review 58's claim, which used to live on `delete process.env[VERIFIER]`. That
    // line is gone with the env transport, and the protocol it enforced — obtaining the payload is the same
    // act as destroying it — moved here rather than ending. One entry, because two pointed at one protocol is
    // how a registry starts describing a thing it no longer tests.
    name: "payload transport — the runner reads the payload and leaves it",
    file: "packages/job-runner/src/job-payload-env.ts",
    from: '      unlinkSync(path);\n      payload = readFileSync(fd, "utf8");',
    to: '      payload = readFileSync(fd, "utf8");\n      try {\n        unlinkSync(path);\n      } catch {}',
    suite: ["--root", "packages/job-runner", "src/job-payload-env.counterexample.test.ts"],
  },
  {
    // arch-review 60 P0. `executing` stamped before the object exists, so the cancellation's birth guard —
    // which covers only the pre-birth states — sees nothing to wait for and certifies zero while a paused
    // submitter still has an `applyJob` to make.
    name: "started-means-born — the K8s lane reports executing before its Job exists",
    file: "packages/backends/src/orchestrators/k8s.ts",
    from: "    await requireActivation(job, work, options?.authority);",
    to: "    await requireActivation(job, work, options?.authority);\n    options?.onStarted?.();",
    suite: ["--root", "packages/backends", "src/orchestrators/started-means-born.counterexample.test.ts"],
  },
  {
    // …and the Nomad lane, whose stamp sat between the reservation and the submit for the same reason.
    name: "started-means-born — the Nomad lane reports executing before its job exists",
    file: "packages/backends/src/orchestrators/nomad.ts",
    from: "    options?.onStarted?.();\n    try {",
    to: "    try {",
    suite: ["--root", "packages/backends", "src/orchestrators/started-means-born.counterexample.test.ts"],
  },
  {
    // arch-review 60 P0. Adoption's stage ignored, so a verifier's verdict is settled as the whole run's
    // result — `harness: "verifier"`, no agent trace, no snapshot, a verdict standing in for the execution it
    // was a verdict about.
    name: "adoption stage — a verifier's verdict settles as the run's own result",
    file: "apps/api/src/composition/runtime-access.ts",
    // Neutralized the way the defect actually WAS, not merely by widening the predicate: dropping the stage
    // check alone leaves `.result` undefined on the verifier arm, which reads as "nothing adopted" and is the
    // safe path by accident. The defect was the case-shaped SHELL, so the shell comes back with it — that is
    // the version this suite was seen red against.
    from: '      if (decision.kind === "adopted" && decision.adopted.stage === "case") {\n        adopted = decision.adopted.result;',
    to: '      if (decision.kind === "adopted") {\n        adopted = ((decision.adopted as { result?: unknown }).result ?? { caseId: "c1", harness: "verifier", trace: [], scores: [] }) as never;',
    suite: ["--root", "apps/api", "src/composition/verifier-is-not-the-run-result.counterexample.test.ts"],
  },
  {
    // arch-review 60 P1. The payload written owner-only across a UID boundary — the init step runs the runner
    // image, the agent's container may run the tenant's own, and a task image with a different USER then
    // cannot read a payload it is looking straight at. Verified EACCES on a real cluster.
    name: "payload permissions — written owner-only across two images",
    file: "packages/contracts/src/execution/job-payload-transport.ts",
    from: "umask 027;",
    to: "umask 077;",
    suite: ["--root", "packages/backends", "src/orchestrators/payload-not-in-agent-env.counterexample.test.ts"],
    build: "@everdict/contracts",
  },
  {
    // arch-review 60 P1-high. The verifier's slot never claimed, so a workspace at its concurrent-execution
    // limit still places every verifier straight at the backend — the judging half doubling the fleet's
    // container count against limits it never consulted.
    name: "verifier slots — the judging half draws on no pool at all",
    file: "apps/api/src/composition/runtime-access.ts",
    from: "        if (admitted === false)",
    to: "        if (false)",
    suite: ["--root", "apps/api", "src/composition/verifier-admission.counterexample.test.ts"],
  },
  {
    // arch-review 60 follow-through. The recovered verdict discarded again, so a run that crashed between its
    // two halves loses the judgment its verifier already produced and re-runs the whole case.
    name: "two-phase case — a recovered verdict is thrown away",
    file: "apps/api/src/composition/runtime-access.ts",
    from: '        if (half.kind === "merged") {',
    to: "        if (false) {",
    suite: ["--root", "apps/api", "src/composition/verifier-is-not-the-run-result.counterexample.test.ts"],
  },
  {
    // …and the staging half: without it there is nothing on file to merge INTO, which is the state
    // arch-review 60 could only skip.
    name: "two-phase case — the agent's half is never staged",
    file: "packages/application-control/src/execution/verifier-pass.ts",
    from: "    await stageAgentHalf(deps.agentHalves, job.tenant, job.runId, result);",
    to: "    void deps.agentHalves;",
    suite: ["--root", "packages/application-control", "src/execution/agent-half.counterexample.test.ts"],
  },
  {
    // arch-review 60 follow-through. The Job born RUNNABLE again, so the object only exists once it can
    // already create pods — and a cancellation probing between the reservation and the apply truthfully
    // answers ABSENT while a birth is pending.
    name: "inert birth — the K8s Job is created runnable",
    file: "packages/backends/src/orchestrators/k8s.ts",
    from: "      suspend: true,",
    to: "      suspend: false,",
    suite: ["--root", "packages/backends", "src/orchestrators/started-means-born.counterexample.test.ts"],
  },
  {
    // …and the refusal path: an inert object left behind when the authority says no. Nothing runs, but the
    // dispatch stops cleaning up after itself, which is how a namespace fills with objects nobody owns.
    name: "inert birth — a refused activation leaves its object behind",
    file: "packages/backends/src/orchestrators/k8s.ts",
    from: [
      "        const reclaimed = await api.deleteJob(name, ns);",
      "        if (verifierAuths.length > 0 && !killConverged(reclaimed))",
      '          await api.deleteDependent("secret", verifierSecret, ns).catch(() => undefined);',
    ].join("\n"),
    to: "        void name;",
    suite: ["--root", "packages/backends", "src/orchestrators/verifier-activation.counterexample.test.ts"],
  },
  {
    // arch-review 60 follow-through. The workspace's WHOLE secret tier reaching the agent's container again —
    // its GitHub App token, its registry passwords, whatever a member saved for an integration.
    name: "agent env — the whole workspace tier reaches the agent's container",
    file: "packages/backends/src/orchestrators/k8s.ts",
    from: "    ...evalContainerSecretEnv(opts.secretEnv),",
    to: "    ...opts.secretEnv,",
    suite: ["--root", "packages/backends", "src/orchestrators/payload-not-in-agent-env.counterexample.test.ts"],
  },
  {
    // arch-review 61 P0. The finite question removed, so a DEFAULT deployment (no tenant quota) binds
    // `Infinity` into the Pg ledger's `in_flight < $3` against an integer column and every private-verifier
    // case dies before its lane is resolved.
    name: "verifier admission — an unlimited quota is bound into an integer comparison",
    file: "apps/api/src/composition/runtime-access.ts",
    from: "quota !== undefined && Number.isFinite(quota)",
    to: "quota !== undefined",
    suite: ["--root", "apps/api", "src/composition/verifier-admission.counterexample.test.ts"],
  },
  {
    // …and the unwinding: a budget reservation held for a verifier that never ran, which permanently inflates
    // the workspace's run count and eventually 402s it for compute that does not exist.
    name: "verifier admission — the budget is never released",
    file: "apps/api/src/composition/runtime-access.ts",
    from: "      if (budgetHeld) admitVerifierCompute?.release(job.tenant);",
    to: "",
    suite: ["--root", "apps/api", "src/composition/verifier-admission.counterexample.test.ts"],
  },
  {
    // arch-review 61 P0. The Nomad group registered runnable, so the first external object a dispatch makes
    // is one that already schedules an allocation — and a cancellation racing it kills nothing, probes
    // absent, and certifies zero while the submission is still pending.
    name: "inert birth — the Nomad group is registered runnable",
    file: "packages/backends/src/orchestrators/nomad.ts",
    from: "          Count: inert ? 0 : 1,",
    to: "          Count: 1,",
    suite: ["--root", "packages/backends", "src/orchestrators/started-means-born.counterexample.test.ts"],
  },
  {
    // …and the lane asking for a runnable registration, which is the same defect one layer up: the builder
    // can render inert and nobody requests it.
    name: "inert birth — the Nomad lane never asks for an inert registration",
    file: "packages/backends/src/orchestrators/nomad.ts",
    from: "      buildNomadJob(job, opts, jobId, verifier?.payload, true),",
    to: "      buildNomadJob(job, opts, jobId, verifier?.payload),",
    suite: ["--root", "packages/backends", "src/orchestrators/started-means-born.counterexample.test.ts"],
  },
  {
    // …and only the main image resolved for credentials, so a private task image beside a private runner
    // image leaves the init container unable to pull.
    name: "pull credentials — only the agent's image is resolved",
    file: "packages/backends/src/orchestrators/k8s.ts",
    from: "  return registryAuthsForImages(registryAuthsOf(job), [mainImage, runnerImage]);",
    to: "  return registryAuthsForImages(registryAuthsOf(job), [mainImage]);",
    suite: ["--root", "packages/backends", "src/orchestrators/destructive-identity.counterexample.test.ts"],
  },
  {
    // arch-review 61 P1-high. The resume moved back OUTSIDE the reclaim, so a resume that throws leaves a
    // suspended Job forever (suspended is not finished, so the TTL never collects it) and a resume the API
    // server applied whose response was lost leaves a running one the caller believed had failed.
    name: "cleanup scope — a failed resume leaks its object",
    file: "packages/backends/src/orchestrators/k8s.ts",
    // Neutralized the way the defect WAS — the resume hoisted above the reclaim — not by rewriting the
    // lines near it. A mutation that only moves a comment tests nothing, which this suite said out loud the
    // first time it was tried.
    from: "      // lost left a running one the caller believed had failed.\n      try {",
    to: "      // lost left a running one the caller believed had failed.\n      await api.resumeJob(name, ns);\n      try {",
    suite: ["--root", "packages/backends", "src/orchestrators/verifier-activation.counterexample.test.ts"],
  },
  {
    // …and the check that does not depend on the key: a verdict attached to a workspace it was never about
    // is a fabricated case, not a lost one.
    name: "agent half — a verdict is merged onto evidence it was never about",
    file: "packages/application-control/src/execution/agent-half.ts",
    from: "  if (staged !== invocation.workspaceDigest)",
    to: "  if (false)",
    suite: ["--root", "packages/application-control", "src/execution/agent-half.counterexample.test.ts"],
  },
  {
    // arch-review 61 P1. The backend's own envelope ignored, so several tenants each inside their own quota
    // still put a lane past its `maxConcurrent` — which a batch's verifier fan-out does routinely.
    name: "verifier capacity — the runtime's envelope is not consulted",
    file: "apps/api/src/composition/runtime-access.ts",
    from: "        if (room.value.used + held >= room.value.total)",
    to: "        if (false)",
    suite: ["--root", "apps/api", "src/composition/verifier-admission.counterexample.test.ts"],
  },
  {
    // …and the LEASE: the ledger's permit expires after 30 minutes, so a verifier that never renews has its
    // slot reaped while its container keeps running and another execution claims it.
    name: "verifier permit — the lease is never renewed",
    file: "apps/api/src/composition/runtime-access.ts",
    from: "        if (permitHeld) renewal = startRenewal(verifierSlots, permitId, verifierSlots.renewEveryMs);",
    to: "",
    suite: ["--root", "apps/api", "src/composition/verifier-admission.counterexample.test.ts"],
  },
  {
    // arch-review 61 P2-audit. The attempt row left open after a recovery adopted its answer and deleted its
    // Job, so the physical ledger reads `active`/`executing` for a container that no longer exists.
    name: "adoption — the adopted attempt is left reading as live work",
    file: "apps/api/src/composition/runtime-access.ts",
    from: '    await deps.attempts.transition(work.attemptId, "committed").catch(() => undefined);',
    to: "    void work;",
    suite: ["--root", "apps/api", "src/composition/verifier-is-not-the-run-result.counterexample.test.ts"],
  },
  {
    // arch-review 62 P0. Both managed lanes create their object INERT so a cancellation always has something
    // to address. A crash before the activation leaves that object with no owner, and adoption used to wait
    // for it to finish — a suspended Job never does, so the run deferred on every boot forever. Neutralize
    // the K8s lane's ability to SEE the phase and the recovery goes back to waiting.
    name: "adoption — an inert K8s Job is waited on instead of reclaimed",
    file: "packages/backends/src/orchestrators/k8s.ts",
    from: "        if (found.suspended === true) {",
    to: "        if (false) {",
    build: "@everdict/backends",
    suite: ["packages/backends/src/orchestrators/inert-recovery.counterexample.test.ts"],
  },
  {
    // The Nomad half of the same phase: a registration at `Count: 0` schedules no allocation, so the poll
    // for one never converges.
    name: "adoption — an inert Nomad registration is waited on instead of reclaimed",
    file: "packages/backends/src/orchestrators/nomad.ts",
    from: '      if (phase.kind === "read" && phase.value === 0) {',
    to: "      if (false) {",
    build: "@everdict/backends",
    suite: ["packages/backends/src/orchestrators/inert-recovery.counterexample.test.ts"],
  },
  {
    // …and the READER half. Teaching the lanes a phase closes nothing while the fold that consumes their
    // answers treats anything it was not taught as "nothing to do here".
    name: "adoption — the fold absorbs a phase it was never taught",
    file: "packages/backends/src/backend.ts",
    from: '    case "inert":\n    case "absent":\n      return { kind: "redrive" };',
    to: '    case "absent":\n      return { kind: "redrive" };\n    case "inert":\n      return { kind: "unresolved" };',
    build: "@everdict/backends",
    suite: ["packages/backends/src/orchestrators/inert-recovery.counterexample.test.ts"],
  },
  {
    // arch-review 62 P0. `POST /v1/jobs` is Nomad's register, and register is create-or-update — so the
    // start that scales the inert registration to one recreated the job whenever a cancellation had deleted
    // it in between. Verified on a live Nomad: unfenced the job comes back 200 and runs; fenced the cluster
    // answers "Enforcing job modify index N: job does not exist". Drop the fence and the race is back.
    name: "nomad start — the start can create the job a cancellation deleted",
    file: "packages/backends/src/orchestrators/nomad.ts",
    from: "      EnforceIndex: true,\n      JobModifyIndex: bornAt,",
    to: "      JobModifyIndex: bornAt,",
    build: "@everdict/backends",
    suite: ["packages/backends/src/orchestrators/start-cannot-create.counterexample.test.ts"],
  },
  {
    // arch-review 62 P1. The arm that takes reservations back before stopping anything was asking the ledger
    // for `rec.id` while the rest of the teardown used `evd-run-${rec.id}` — so it matched no row and a
    // paused submitter could still place after the cancellation certified zero. Read once, derive both;
    // point the derivation at a different list and the counterexample goes red again.
    name: "cancellation — the revocation arm is about different rows than the kill",
    file: "packages/application-control/src/run/run-service.ts",
    from: "      for (const { attemptId } of rowsRead.value.filter((a) => !isTerminalAttemptState(a.state)))",
    to: "      for (const { attemptId } of [].filter((a) => !isTerminalAttemptState(a.state)))",
    build: "@everdict/application-control",
    suite: ["packages/application-control/src/run/revocation-coordinate.counterexample.test.ts"],
  },
  {
    // arch-review 62 P1. `.catch(() => undefined)` then `room !== undefined &&` made an unreadable cluster
    // mean "place it", while the Scheduler answers the same question fail-closed. Restore the permissive
    // read and the refusal disappears.
    name: "verifier admission — an unreadable capacity probe reads as headroom",
    file: "apps/api/src/composition/runtime-access.ts",
    from: "        const room = await readOrUnknown(() => backend.capacity(), `capacity of runtime '${target}'`);\n        if (room.kind !== \"read\")",
    to: '        const room = { kind: "read", value: await backend.capacity().catch(() => ({ used: 0, total: 1 })) };\n        if (false)',
    suite: ["--root", "apps/api", "src/composition/verifier-admission.counterexample.test.ts"],
  },
  {
    // …and the other half: a reading is not a reservation. Without the lane's own in-flight count, concurrent
    // verifiers all see the same free slot in a snapshot none of them is visible in yet.
    name: "verifier admission — the lane does not count the slots it is holding",
    file: "apps/api/src/composition/runtime-access.ts",
    from: "        const held = verifiersHeld.get(target) ?? 0;",
    to: "        const held = 0;",
    suite: ["--root", "apps/api", "src/composition/verifier-admission.counterexample.test.ts"],
  },
  {
    // arch-review 62 P1. A per-tenant COUNT is compared against an integer column by Postgres, which parses
    // the driver's text form: `invalid input syntax for type integer: "1.5"`. Accept fractions again and the
    // config that breaks one tenant's admissions boots clean.
    name: "scheduling config — a fractional count is accepted for a whole-number ledger",
    file: "packages/application-control/src/ops/scheduling-config.ts",
    from: '      (kind === "weight" || (Number.isInteger(value) && value <= PG_INT_MAX));',
    to: "      true;",
    build: "@everdict/application-control",
    suite: ["packages/application-control/src/ops/quota-grammar.counterexample.test.ts"],
  },
  {
    // arch-review 62 P1. `committed` says this attempt's result is the case's answer; reserving and
    // activating re-ask whether the parent still authorizes them, and the write that claims the outcome did
    // not. Remove the question and a verdict produced under a settlement that already closed is recorded as
    // that settlement's answer.
    name: "attempt ledger — committed does not answer to the parent that settled",
    file: "packages/application-control/src/ports/execution-attempt-store.ts",
    from: '    if (to === "committed") {',
    to: "    if (false) {",
    build: "@everdict/application-control",
    suite: ["packages/application-control/src/execution/committed-means-settled.counterexample.test.ts"],
  },
  {
    // …and the other direction: gating the states that merely CLOSE a row would leave attempts reading live
    // forever under a cancelled parent, which is a worse defect than the one above.
    name: "attempt ledger — a closing transition is gated like a claiming one",
    file: "packages/application-control/src/ports/execution-attempt-store.ts",
    from: '    if (to === "committed") {',
    to: "    if (isTerminalAttemptState(to)) {",
    build: "@everdict/application-control",
    suite: ["packages/application-control/src/execution/committed-means-settled.counterexample.test.ts"],
  },
  {
    // arch-review 62 P1-provenance. `complete` asked only whether a handle was present, so the K8s lane —
    // which answers {tenant, runId, externalJobId, namespace} — produced receipts reading complete that no
    // query could join to the attempt row that made them.
    name: "verifier receipt — presence of a handle passes for a join to the attempt",
    file: "packages/domain/src/execution/verifier-receipt.ts",
    from: "      invocation.work?.attemptId !== undefined &&\n      invocation.work.verifier !== undefined &&",
    to: "      invocation.work !== undefined &&",
    build: "@everdict/domain",
    suite: ["packages/domain/src/execution/verifier-receipt.counterexample.test.ts"],
  },
  {
    // …and the operation half: the lane's own answer used to win over the ledger's canonical row, which is
    // the reason the receipt could not be joined in the first place.
    name: "verifier operation — the lane's handle wins over the row's canonical one",
    file: "packages/application-control/src/execution/verifier-operation.ts",
    from: "    return { ...invocation, work: persistedWork };",
    to: "    return { ...invocation, work: invocation.work ?? persistedWork };",
    build: "@everdict/application-control",
    suite: ["packages/application-control/src/execution/verifier-receipt-work.counterexample.test.ts"],
  },
  {
    // arch-review 62 P1. The staged half was keyed by the workspace, which two attempts of one case can
    // share — so the later write replaced the earlier and a recovered verdict could be merged onto another
    // execution's evidence. Key by the tree again and the two attempts collide.
    name: "agent half — the staged half is keyed by something two attempts share",
    file: "packages/application-control/src/execution/agent-half.ts",
    from: "  return contentDigest(result);",
    to: "  return contentDigest(result.snapshot);",
    build: "@everdict/application-control",
    suite: ["packages/application-control/src/execution/agent-half.counterexample.test.ts"],
  },
  {
    // …and the batch recovery owner, which skipped a completed verifier and re-drove the whole case while
    // the standalone owner merged. One protocol, two behaviours.
    name: "batch recovery — a completed verifier is discarded instead of finished",
    file: "packages/application-control/src/scorecard/recovery-planner.ts",
    from: '            if (decision?.kind === "adopted" && decision.adopted.stage === "verifier") {',
    to: "            if (false) {",
    build: "@everdict/application-control",
    suite: ["packages/application-control/src/execution/one-recovery-protocol.counterexample.test.ts"],
  },
  {
    // arch-review 62 P1. The pull Secret was applied beside the Job and owned one call later, so a uid that
    // could not be read left a credential nothing would collect — and `patchOwnedByJob` had no way to say so.
    // Remove the refusal and the lane creates an orphan credential again.
    // PER LANE, because this file holds two dispatches spelled almost alike and a single `from` neutralizes
    // whichever appears first — which is how the first draft of this entry passed while the agent lane was
    // untested (arch-review 61's sibling-lane lesson, hit again).
    name: "k8s pull secret (agent lane) — a credential is created that nothing will reclaim",
    file: "packages/backends/src/orchestrators/k8s.ts",
    from: "          // that did not happen, and the reclaim below removes the inert Job this attempt made.\n          const uid = await api.jobUid(name, ns);",
    to: '          const uid = (await api.jobUid(name, ns)) ?? "x";',
    build: "@everdict/backends",
    suite: ["packages/backends/src/orchestrators/pull-secret-lifecycle.counterexample.test.ts"],
  },
  {
    name: "k8s pull secret (verifier lane) — a credential is created that nothing will reclaim",
    file: "packages/backends/src/orchestrators/k8s.ts",
    from: "        if (verifierAuths.length > 0) {\n          const uid = await api.jobUid(name, ns);",
    to: '        if (verifierAuths.length > 0) {\n          const uid = (await api.jobUid(name, ns)) ?? "x";',
    build: "@everdict/backends",
    suite: ["packages/backends/src/orchestrators/pull-secret-lifecycle.counterexample.test.ts"],
  },
  {
    // …and the other half: owner-GC only runs when the owner goes, so a delete that did not converge leaves
    // the dependents with nobody to collect them. Ignore the outcome and the credential stays.
    name: "k8s pull secret (agent lane) — the reclaim ignores whether the delete converged",
    file: "packages/backends/src/orchestrators/k8s.ts",
    from: "        if (auth.length > 0 && !killConverged(reclaimed))",
    to: "        if (false && !killConverged(reclaimed))",
    build: "@everdict/backends",
    suite: ["packages/backends/src/orchestrators/pull-secret-lifecycle.counterexample.test.ts"],
  },
  {
    name: "k8s pull secret (verifier lane) — the reclaim ignores whether the delete converged",
    file: "packages/backends/src/orchestrators/k8s.ts",
    from: "        if (verifierAuths.length > 0 && !killConverged(reclaimed))",
    to: "        if (false && !killConverged(reclaimed))",
    build: "@everdict/backends",
    suite: ["packages/backends/src/orchestrators/pull-secret-lifecycle.counterexample.test.ts"],
  },
  {
    // arch-review 62 follow-through. The Nomad lane reclaimed its object on each refusal somebody had
    // enumerated, and the START was not among them — a 5xx, a reset connection or a timeout threw past every
    // hand-rolled delete and left an inert registration nothing collects. Remove the scope and the list of
    // enumerated failures is back.
    name: "nomad dispatch — a failure between birth and start leaves its object behind",
    file: "packages/backends/src/orchestrators/nomad.ts",
    from: "      const reclaimed = await reclaimInert();",
    to: '      const reclaimed = "reclaimed";',
    build: "@everdict/backends",
    suite: ["packages/backends/src/orchestrators/nomad-birth-cleanup.counterexample.test.ts"],
  },
  {
    // arch-review 62 follow-through. The staged agent half is an intermediate artifact — a full CaseResult,
    // trace and snapshot included — and the port was put/get, so one survived every private-verifier case
    // forever. Its window has two ends and BOTH close it; drop the in-line one and the residue is back.
    name: "agent half — the in-line pass keeps the half it staged",
    file: "packages/application-control/src/execution/verifier-pass.ts",
    from: "    await discardAgentHalf(deps.agentHalves, halfKey);\n  }\n}",
    to: "  }\n}",
    build: "@everdict/application-control",
    suite: ["packages/application-control/src/execution/agent-half.counterexample.test.ts"],
  },
  {
    // …and the recovery end of the same window.
    name: "agent half — the recovery keeps the half it merged",
    file: "packages/application-control/src/execution/agent-half.ts",
    from: "  await discardAgentHalf(store, agentHalfKey(tenant, runId, digest));",
    to: "  void digest;",
    build: "@everdict/application-control",
    suite: ["packages/application-control/src/execution/one-recovery-protocol.counterexample.test.ts"],
  },
  {
    // arch-review 62 follow-through. The verifier lane admitted on slot COUNT alone while the Scheduler has
    // always admitted on slots AND the declared memory envelope AND the declared CPU envelope. Drop the
    // shared decision back to a count and a heavy verifier lands on a lane whose memory is already spent.
    name: "verifier admission — the lane admits on slot count alone",
    file: "apps/api/src/composition/runtime-access.ts",
    from: "        if (!slotAdmits(slot, need))",
    to: "        if (slot.free <= 0)",
    suite: ["--root", "apps/api", "src/composition/verifier-admission.counterexample.test.ts"],
  },
  {
    // arch-review 62 follow-through. The receipt named the attempt that JUDGED and not the one that was
    // judged, so a merged two-phase case could not say which execution its verdict was about — only which
    // logical run, which is the same across a retry.
    name: "verifier verdict — the judged execution is not named",
    file: "packages/application-control/src/execution/verifier-operation.ts",
    from: "      ...(job.agentAttemptId !== undefined ? { agentAttemptId: job.agentAttemptId } : {}),\n    };",
    to: "    };",
    build: "@everdict/application-control",
    suite: ["packages/application-control/src/execution/verifier-receipt-work.counterexample.test.ts"],
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
