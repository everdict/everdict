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
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const MUTATIONS = [
  // ── THE EVOLUTION LOOP, DRIVEN FOR REAL (docs/architecture/evolution-lineage.md) ─────────────────
  //
  // Three defects found by standing a campaign up end to end against a real harness. Each is silent: the
  // version registers, the round is comparable, the number comes back looking like an ordinary result.
  {
    // An override key the template's KIND cannot apply is ignored by `resolveHarnessInstance` and stripped by
    // the instance schema, so a plausible-but-wrong nesting registers the template's own bytes under a new
    // version label — and a campaign then compares its baseline with itself.
    name: "evolution — an override the template cannot apply is registered instead of refused",
    file: "packages/registry/src/harness/harness-instance-registry.ts",
    from: "  const defects = instanceOverrideDefects(template.kind, instance.overrides);",
    to: "  const defects = (void instanceOverrideDefects, [] as string[]);",
    build: "@everdict/registry",
    suite: ["--root", "packages/registry", "src/harness/harness-instance-registry.test.ts"],
  },
  {
    // …and the ADOPTION lane, which validated with nothing at all in the in-memory twin while the Pg twin has
    // resolved and asserted since arch-review 77 — so every unit test of the lane where a dropped variation
    // costs a campaign its evidence was green against a store more permissive than production.
    name: "evolution — the in-memory adoption lane stops validating what it registers",
    file: "packages/registry/src/harness/harness-instance-registry.ts",
    from: "    const template = await this.templates.get(tenant, instance.template.id, instance.template.version);\n    assertRegistrableInstance(template, instance);\n    return this.store.registerPreservingOwner(tenant, instance, createdBy, origin, authority);",
    to: "    void this.templates;\n    return this.store.registerPreservingOwner(tenant, instance, createdBy, origin, authority);",
    build: "@everdict/registry",
    suite: ["--root", "packages/registry", "src/harness/harness-instance-registry.test.ts"],
  },
  {
    // A round whose two sides ran the same harness bytes reads 0 improvements and 0 regressions — which the
    // driver is told to treat as NEUTRAL and build on — while it spends a slot of the pre-registered held-out
    // family and moves the consecutive-rejection counter. The direction was never tried.
    name: "evolution — a round compares the baseline with itself and calls the result neutral",
    file: "packages/application-control/src/evolution/campaign-service.ts",
    from: '    frame.subject.type === "harness" &&\n    baselineSpecDigest !== undefined &&\n    baselineSpecDigest === candidateSpecDigest',
    to: "    false",
    build: "@everdict/application-control",
    suite: ["--root", "apps/api", "src/api/campaign/campaign.routes.test.ts"],
  },
  {
    // …and the other half: an ENVIRONMENT campaign REQUIRES the harness to be identical on both sides, so an
    // unscoped version of that guard refuses exactly the campaigns it is not about.
    name: "evolution — the identical-bytes guard is unscoped and breaks environment campaigns",
    file: "packages/application-control/src/evolution/campaign-service.ts",
    from: '    frame.subject.type === "harness" &&\n    baselineSpecDigest !== undefined',
    to: "    baselineSpecDigest !== undefined",
    build: "@everdict/application-control",
    suite: ["--root", "apps/api", "src/api/campaign/campaign.routes.test.ts"],
  },
  {
    // A setup step used to exec with no env at all while the command got the whole of it, so a step naming a
    // spec variable expanded it to the empty string, exited 0, and the harness ran in a sandbox nobody had
    // prepared — a case that comes back looking like an agent that did nothing.
    name: "evolution — a harness setup step runs without the spec's env",
    file: "packages/harnesses/src/command.ts",
    from: "      const res = await compute.exec(cmd, { cwd, env });",
    to: "      const res = await compute.exec(cmd, (void env, { cwd }));",
    build: "@everdict/harnesses",
    suite: ["--root", "packages/harnesses", "src/command.test.ts"],
  },
  // ── THE WORLD A CASE ACTS ON (docs/architecture/world-and-engagement-model.md) ────────────────────
  //
  // Slices 3.9 and 3.95 landed a created-world ledger and a world a batch's cases share. Every fence below is
  // silent when removed: the world still comes up, the cases still run, and the number that comes back looks
  // like an ordinary result. These are the neutralizations that were driven by hand when the slices landed,
  // recorded here so a later refactorer meets them instead of a green suite.
  {
    // L5. `released` is written only after a read-back says the world is not standing. A world that IS still
    // standing must stay owed — "the teardown was accepted" is not "it is gone".
    name: "world — a world still standing after its teardown is settled released",
    file: "packages/application-control/src/environment/created-world.ts",
    from: '  if (standing) return owe("the world is still standing after its teardown");',
    to: '  if (false) return owe("the world is still standing after its teardown");',
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/environment/created-world.counterexample.test.ts"],
  },
  {
    // L5's third value. A runtime that could not answer is `unknown` — an escalation, never a licence to
    // settle. Reading silence as "gone" is the collapse the whole union exists to refuse.
    name: "world — a runtime that cannot say whether the world stands is read as gone",
    file: "packages/application-control/src/environment/created-world.ts",
    from: '  if (standing === undefined)\n    return owe("the runtime could not say whether the world is still standing — accepted is not gone");',
    to: '  if (standing === undefined) return { kind: "released" as const };',
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/environment/created-world.counterexample.test.ts"],
  },
  {
    // 3.95. `acquireShared` elects exactly one creator; every other case JOINS and is handed the coordinates
    // the creator got. An acquirer that always creates makes one world per case — the reuse this arm exists
    // for, gone — and two of them under one ledger row.
    name: "shared world — every acquirer builds its own world instead of joining",
    file: "packages/application-control/src/environment/created-world.ts",
    from: "  if (joined.created) {",
    to: "  if (true) {",
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/environment/created-world.counterexample.test.ts"],
  },
  {
    // 3.95. Leaving is not tearing down, and neither is being the last one out: releasing when the count hits
    // zero makes a sequentially-dispatched batch build and destroy one world per case, and refuses the next
    // case, which arrives while the teardown is in flight. The reconciler is the reaper.
    name: "shared world — the last case out tears the world down instead of leaving it",
    file: "packages/application-control/src/environment/created-world.ts",
    from: '    return { kind: "held", holders: left.holders };',
    to: '    if (left.holders > 0) return { kind: "held", holders: left.holders };\n    return releaseWorld({ tenant, id: left.row.id, runId: left.row.runId, services, creator, store });',
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/environment/created-world.counterexample.test.ts"],
  },
  {
    // 3.95. The declared reset runs before every case. Without it case N starts in the state case N-1 left,
    // and cases that are not independent are not a comparison.
    name: "shared world — the per-case reset never runs",
    file: "packages/application-control/src/environment/created-world.ts",
    from: "    await input.reset(wiring);",
    to: "    void input.reset;",
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/environment/created-world.counterexample.test.ts"],
  },
  {
    // …and a reset that FAILED refuses the case. Swallowing it runs the case in the previous one's leftovers,
    // which is the same defect as never resetting, arriving through a catch instead of an omission.
    name: "shared world — a reset that failed is swallowed instead of refusing the case",
    file: "packages/application-control/src/environment/created-world.ts",
    from: "    await input.reset(wiring);",
    to: "    await input.reset(wiring).catch(() => undefined);",
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/environment/created-world.counterexample.test.ts"],
  },
  {
    // 3.95. A joiner waits for the creator, and a creator that FAILED (or a world being unmade) ends that wait
    // in a refusal. Waiting on instead of refusing dispatches the case into a world that is not there.
    name: "shared world — a joiner waits for a creator that already failed",
    file: "packages/application-control/src/environment/created-world.ts",
    from: '    if (row === undefined || row.state === "unknown" || row.state === "released" || row.state === "releasing") {',
    to: "    if (false) {",
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/environment/created-world.counterexample.test.ts"],
  },
  {
    // 3.95. The key is what makes two acquisitions ONE world, and the batch is its scope. Dropping the scope
    // makes every batch that names the same environment share a world — and compare against each other's
    // leftovers, which is the exact dependency `perCase.reset` exists to remove.
    name: "shared world — the key forgets which batch is asking",
    file: "packages/application-control/src/environment/created-world.ts",
    from: '  return `${input.scope}|${input.environment}|${input.target ?? "-"}`;',
    to: '  return (void input.scope, `${input.environment}|${input.target ?? "-"}`);',
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/environment/world-provider.counterexample.test.ts"],
  },
  {
    // 3.95. The environment's declared lifecycle is what the dispatcher routes on. Ignoring it makes every
    // per-run world a per-case one: correct-looking, and the batch pays for one world per case.
    name: "shared world — the dispatcher ignores the declared lifecycle",
    file: "packages/application-control/src/environment/world-provider.ts",
    from: '      create.lifecycle === "per-run"',
    // `void this.joinShared` keeps the now-unreachable arm READ, so `noUnusedPrivateClassMembers` does not
    // refuse the mutated tree — the compiler objecting to the shape of a neutralization is not the protocol
    // being enforced, and declaring it as one would record a certificate for a suite that never ran.
    to: "      (void this.joinShared, false)",
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/environment/world-provider.counterexample.test.ts"],
  },
  {
    // 3.95, the residue. The environment schema refuses to REGISTER a per-run world with no reset; this is the
    // refusal for a case that reached the dispatcher any other way. Defaulting instead of refusing chains the
    // batch's cases behind a reset nobody declared.
    name: "shared world — a per-run world with no declared reset is run anyway",
    file: "packages/application-control/src/environment/world-provider.ts",
    from: "    const perCase = create.perCase;",
    to: '    const perCase = create.perCase ?? { reset: "/reset", from: "target_base_url" };',
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/environment/world-provider.counterexample.test.ts"],
  },
  {
    // 3.95, authorship. The base URL is minted by the platform for a world it created; the reset PATH is
    // written by a workspace. Without the origin check a path that resolves elsewhere makes the control plane
    // dial an address a tenant chose.
    name: "shared world — the reset is dialled at whatever host the path resolves to",
    file: "packages/application-control/src/environment/world-provider.ts",
    from: "  if (target.origin !== origin.origin)",
    to: "  if (false)",
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/environment/world-provider.counterexample.test.ts"],
  },
  {
    // 3.95, in the adapter. `xmax = 0` is how the winner learns its INSERT inserted; it exists only inside a
    // real MVCC snapshot, which is why this rung drives the Postgres scenario rather than the twin.
    name: "shared world — every acquirer is told it inserted the row (real Postgres)",
    file: "packages/db/src/environment/world-creation-store.ts",
    from: "                 (xmax = 0) AS mine`,",
    to: "                 true AS mine`,",
    build: "@everdict/db",
    suite: ["--root", "apps/api", "src/trust/shared-world-election.trust.test.ts"],
    env: { EVERDICT_TRUST_SUITE: "1" },
    requiresEnv: ["EVERDICT_TRUST_DATABASE_URL"],
  },
  {
    // 3.95, the fence in SQL. A shared world is owed when nobody is inside it AND nobody has been for the idle
    // window. Dropping the holder guard sweeps a world a live case is still acting in — worse than a leak,
    // because the score that comes back reads as an ordinary agent failure.
    name: "shared world — the reaper takes a world somebody is inside (real Postgres)",
    file: "packages/db/src/environment/world-creation-store.ts",
    from: "            OR (shared_key IS NOT NULL AND ((holders = 0 AND updated_at <= $1) OR expires_at <= $2))",
    to: "            OR (shared_key IS NOT NULL AND (updated_at <= $1 OR expires_at <= $2))",
    build: "@everdict/db",
    suite: ["--root", "apps/api", "src/trust/shared-world-election.trust.test.ts"],
    env: { EVERDICT_TRUST_SUITE: "1" },
    requiresEnv: ["EVERDICT_TRUST_DATABASE_URL"],
  },
  {
    // 3.95. Two reclaimers for one object. A created world is ensured ONCE and then used by every case of a
    // batch, so the warm pool's `lastUsedAt` says idle while cases are still inside it — and the default idle
    // TTL is thirty minutes. The ledger owns this decision; the pool defers.
    name: "shared world — the docker warm pool reclaims a created world",
    file: "packages/topology/src/deploy/docker-runtime.ts",
    from: "      if (isWorldTopology(entry.spec.id)) continue;",
    to: "      void isWorldTopology;",
    build: "@everdict/topology",
    suite: ["--root", "packages/topology", "src/deploy/docker-runtime.test.ts"],
  },
  {
    // 3.95. Two reclaimers for one object. A created world is ensured ONCE and then used by every case of a
    // batch, so the warm pool's `lastUsedAt` says idle while cases are still inside it — and the default idle
    // TTL is thirty minutes. The ledger owns this decision; the pool defers.
    name: "shared world — the nomad warm pool reclaims a created world",
    file: "packages/topology/src/deploy/nomad-runtime.ts",
    from: "      if (isWorldTopology(entry.spec.id)) continue;",
    to: "      void isWorldTopology;",
    build: "@everdict/topology",
    suite: ["--root", "packages/topology", "src/deploy/nomad-runtime.test.ts"],
  },
  {
    // 3.95. Two reclaimers for one object. A created world is ensured ONCE and then used by every case of a
    // batch, so the warm pool's `lastUsedAt` says idle while cases are still inside it — and the default idle
    // TTL is thirty minutes. The ledger owns this decision; the pool defers.
    name: "shared world — the k8s warm pool reclaims a created world",
    file: "packages/topology/src/deploy/k8s-runtime.ts",
    from: "      if (isWorldTopology(entry.spec.id)) continue;",
    to: "      void isWorldTopology;",
    build: "@everdict/topology",
    suite: ["--root", "packages/topology", "src/deploy/k8s-runtime.test.ts"],
  },
  {
    // Axis 1's observation channel. A recording that was PROMISED and could not be read makes the whole
    // observation `sampling_failed`; reading it as an empty account tells a judge the world was quiet.
    name: "world recording — an execution site that cannot fetch a promised recording reports an empty account",
    file: "packages/application-execution/src/run-case.ts",
    from: "      if (url === undefined || fetchRecording === undefined) recordingFailed = true;",
    to: "      if (url === undefined || fetchRecording === undefined) recordingFailed = false;",
    build: "@everdict/application-execution",
    suite: ["--root", "packages/application-execution", "src/world-recording.counterexample.test.ts"],
  },
  {
    // …and the same collapse arriving through a catch: a fetch that THREW is not a world that was quiet.
    name: "world recording — a recording fetch that threw is read as a world that published nothing",
    file: "packages/application-execution/src/run-case.ts",
    from: "        } catch {\n          recordingFailed = true;\n        }",
    to: "        } catch {\n          recordingFailed = false;\n        }",
    build: "@everdict/application-execution",
    suite: ["--root", "packages/application-execution", "src/world-recording.counterexample.test.ts"],
  },
  {
    // The grader that reads it. A world nobody could read is `unmeasured`, never a 0 — the L2 distinction the
    // whole channel exists to keep, at the one place it turns into a number.
    name: "world state — a world that published no account is scored zero instead of unmeasured",
    file: "packages/graders/src/world-state.ts",
    from: "        return unmeasured(`the world published no account this run (${observations.reason})`);",
    to: '        return { graderId: "world-state", metric: "world_state", value: 0, pass: false };',
    build: "@everdict/graders",
    suite: ["--root", "packages/graders", "src/world-state.test.ts"],
  },
  {
    // Axis 2's refusal. A dialogue case meeting a harness that cannot hold a conversation would make every
    // turn an independent run — the exchange a fiction, and the score computed over it about nothing.
    name: "dialogue — a harness that cannot hold a conversation is handed a dialogue case anyway",
    file: "packages/application-execution/src/run-case.ts",
    from: "    if (userBudget > 0 && deps.harness.conversational !== true)",
    to: "    if (false)",
    build: "@everdict/application-execution",
    suite: ["--root", "packages/application-execution", "src/dialogue-engagement.counterexample.test.ts"],
  },
  {
    // …and its twin: a MODEL user with no simulator. Running it as a one-shot measures a first turn and
    // reports it as a conversation, which is the same fiction arriving through a missing capability.
    name: "dialogue — a model-user case runs as a one-shot when no simulator was given",
    file: "packages/application-execution/src/run-case.ts",
    from: '    if (engagement?.user.kind === "model" && deps.simulateUser === undefined)',
    to: "    if (false)",
    build: "@everdict/application-execution",
    suite: ["--root", "packages/application-execution", "src/dialogue-engagement.counterexample.test.ts"],
  },
  {
    // Axis 2. The simulated user ends the exchange by SAYING its stop sentence, and that turn is dropped
    // rather than delivered — so the transcript a judge reads carries no instruction the platform wrote.
    name: "dialogue — the user simulator delivers its own stop sentence as a turn",
    file: "packages/graders/src/user-simulator.ts",
    from: "    return trimmed.length === 0 || trimmed.includes(done) ? undefined : said;",
    to: "    return (void trimmed, void done, said);",
    build: "@everdict/graders",
    suite: ["--root", "packages/graders", "src/user-simulator.test.ts"],
  },
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
    // harness-definability-spec.md §2. A batch SEALS the environment version each referencing case resolved
    // to, and every execution lane afterwards re-resolves through that seal. Reading the declared ref again
    // (which a `latest` ref answers freshly) lets a resumed or retried batch finish its remaining cases in a
    // world its finished ones never saw — with the manifest still claiming one experiment.
    name: "DEF2 — an execution lane re-resolves the environment ref instead of the batch's seal",
    file: "packages/application-control/src/environment/case-environment.ts",
    from: "    const version = pinned !== undefined ? refVersion(pinned.ref) : declared.version;",
    to: "    const version = (void refVersion, declared.version);",
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/environment/case-environment.counterexample.test.ts"],
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
    // RE-AIMED (arch-review 63): the predicate grew the judged execution, so the resolved-provenance clause
    // sits two lines lower. The protocol is unchanged — call unresolved provenance complete and the one
    // signal for "this verdict is not fully attributed" says yes for the case it exists to flag.
    //
    // ⚠️ THIS RUNG HAD NEVER RUN (arch-review 120). The clause it replaces is the LAST operand of the `&&`
    // chain, and the replacement kept a trailing `&&` — so the file did not parse, vitest collected nothing,
    // and for as long as an uncompilable tree was discarded the rung read as covered. It is the shape rule
    // `ci` names: the compiler objecting to the mutation's SYNTAX is not the protocol being protected. The
    // replacement is a clause line 74 already implies, so the chain still compiles and only the provenance
    // requirement is gone — which makes the SUITE the thing that refuses.
    from: '      invocation.imageProvenance?.kind === "resolved",',
    to: "      invocation.work !== undefined,",
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
    // RE-AIMED (arch-review 64): the lane stamps `verdict_produced` now — a produced verdict is not an
    // adopted one — so the CAS this rung neutralizes moved with it.
    from: '    if (!(await attempts.transition(attemptId, "verdict_produced"))) {',
    to: '    await attempts.transition(attemptId, "verdict_produced");\n    if (false) {',
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
    // RE-AIMED (Track B): the provenance is now observation-first (`observedPlacementImage` ?? lane reading),
    // but the protocol under test is unchanged — the placement FILLS a gap and never overwrites a driver
    // that actually read the digest, and `withPlacementImage` owns that merge.
    from: "  return { ...result, execution: withPlacementImage(result.execution, provenance) };",
    to: "  return { ...result, execution: { ...result.execution, imageProvenance: provenance } };",
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
    // Defeating the narrowing makes `worksRead.reason` a type error, so the TYPE SYSTEM refuses to let this
    // guard be removed — enforcement stronger than a red suite, and it has to be declared because an
    // uncompilable replacement otherwise reads as a rung that tests nothing (arch-review 115).
    compilerEnforced: true,
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
    to: '    const placed = placedRead.kind === "read" ? placedRead.value.slice(0, 0) : [];',
    suite: ["--root", "apps/api", "src/core/scorecard/cancellation-work-debt.counterexample.test.ts"],
    build: "@everdict/application-control",
  },
  {
    // …and the enumeration half: a ledger this teardown could not read is not a batch that placed nothing.
    name: "Wave 3 — an unreadable ledger becomes an empty workset",
    file: "packages/application-control/src/scorecard/scorecard-service.ts",
    from: '    if (placedRead.kind === "unknown")',
    to: "    if (false)",
    // The mutated tree does not compile: removing this guard is a TYPE error at its consumer, which is
    // the type system refusing to let the protocol go — enforcement stronger than a red suite, and
    // declared because an uncompilable replacement otherwise reads as a rung that tests nothing
    // (arch-review 115, classified in 119).
    compilerEnforced: true,
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
    to: '      void outcome;\n      if (this.deps.probeWork && item.work.externalJobId === "not-a-job") {',
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
    // RE-AIMED (arch-review 67): the dispatch carries an acknowledgement so the agent half is staged before
    // its container is reclaimed, so the call spans several lines. The neutralization is unchanged — hand the
    // agent the WHOLE case and the private material goes into its container.
    from: "    { ...job, evalCase: plan.remainder },",
    to: "    job,",
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
    to: "      void at;\n      const abandoned: typeof activeBirths = [];",
    suite: ["--root", "apps/api", "src/core/scorecard/authorized-submitter.counterexample.test.ts"],
    build: "@everdict/application-control",
  },
  {
    // …and the other direction, which is the one that would be worse than the defect: the lease ignored, so a
    // submitter milliseconds from creating its object is revoked on a probe that is not yet authoritative.
    name: "activation lease — a live submitter is revoked inside its own window",
    file: "packages/application-control/src/scorecard/scorecard-service.ts",
    from: "at - Date.parse(a.updatedAt) >= ACTIVATION_LEASE_MS",
    to: "(void at, true)",
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
    file: "packages/application-control/src/execution/agent-half.ts",
    // RE-AIMED (arch-review 62 follow-through): the stage moved to where the window actually opens —
    // immediately before the second container — so it no longer runs for cases refused two lines later.
    // RE-AIMED (arch-review 66): the staging also records the cleanup debt now, so it takes the ledger.
    // RE-AIMED (arch-review 67): staging happens in the acknowledgement when the lane has one, and here
    // otherwise. Neutralizing the WRITER covers both paths — see the durability rung for the same move.
    // RE-AIMED (arch-review 70): the writer answers a staged/absent union now — neutralized to always
    // report absent without writing, which is the same "never staged" world.
    from: '  if (!store) return { kind: "absent", reason: "no agent-half store" };',
    to: '  if (!store || true) return { kind: "absent", reason: "no agent-half store" };',
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
    // RE-AIMED (arch-review 63): the call moved inside the `.request(...)` whose lost-response reclaim was
    // added beside it, so the old bare-argument line no longer exists.
    from: '      .request("POST", "/v1/jobs", buildNomadJob(job, opts, jobId, verifier?.payload, true))',
    to: '      .request("POST", "/v1/jobs", buildNomadJob(job, opts, jobId, verifier?.payload))',
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
    // …and the LEASE: the ledger's permit expires after 30 minutes, so a verifier that never renews has its
    // slot reaped while its container keeps running and another execution claims it.
    name: "verifier permit — the lease is never renewed",
    file: "apps/api/src/composition/runtime-access.ts",
    from: "        if (permitHeld) renewal = startRenewal(verifierSlots, permitId, verifierSlots.renewEveryMs);",
    to: "",
    suite: ["--root", "apps/api", "src/composition/verifier-admission.counterexample.test.ts"],
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
    // The mutated tree does not compile: removing this guard is a TYPE error at its consumer, which is
    // the type system refusing to let the protocol go — enforcement stronger than a red suite, and
    // declared because an uncompilable replacement otherwise reads as a rung that tests nothing
    // (arch-review 115, classified in 119).
    compilerEnforced: true,
    suite: ["packages/backends/src/orchestrators/inert-recovery.counterexample.test.ts"],
  },
  {
    // …and the READER half. Teaching the lanes a phase closes nothing while the fold that consumes their
    // answers treats anything it was not taught as "nothing to do here".
    //
    // RE-AIMED (arch-review 63): the inert arm now also names the object it reclaimed, so the return moved.
    // The protocol is unchanged — route `inert` to `unresolved` and a reclaimed object leaves the run
    // deferred forever, which is the defect the arm was added to close.
    name: "adoption — the fold absorbs a phase it was never taught",
    file: "packages/backends/src/backend.ts",
    from: '      return { kind: "redrive", reclaimed: outcome.work };',
    to: '      return { kind: "unresolved" };',
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
    // RE-AIMED (arch-review 62 follow-through): the start moved inside the dispatch's one cleanup scope, so
    // the block is indented one level deeper. The protocol is unchanged.
    from: "        EnforceIndex: true,\n        JobModifyIndex: bornAt,",
    to: "        JobModifyIndex: bornAt,",
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
    // The mutated tree does not compile: removing this guard is a TYPE error at its consumer, which is
    // the type system refusing to let the protocol go — enforcement stronger than a red suite, and
    // declared because an uncompilable replacement otherwise reads as a rung that tests nothing
    // (arch-review 115, classified in 119).
    compilerEnforced: true,
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
    // …and the other half: a reading is not a reservation. Without the lane recording what it holds,
    // concurrent verifiers all see the same free slot in a snapshot none of them is visible in yet.
    //
    // RE-AIMED (arch-review 63): what the lane holds lives on the shared `Admission` now, so the neutralized
    // line is the reservation itself rather than a local map read.
    name: "verifier admission — the lane does not count the slots it is holding",
    file: "apps/api/src/composition/runtime-access.ts",
    from: "        verifiersHeld.reserve(target, job.tenant, need.memoryMb ?? 0, need.cpu ?? 0, `verify:${job.caseId}`);",
    to: "        void target;",
    suite: ["--root", "apps/api", "src/composition/verifier-admission.counterexample.test.ts"],
  },
  {
    // arch-review 62 P1. A per-tenant COUNT is compared against an integer column by Postgres, which parses
    // the driver's text form: `invalid input syntax for type integer: "1.5"`. Accept fractions again and the
    // config that breaks one tenant's admissions boots clean.
    name: "scheduling config — a fractional count is accepted for a whole-number ledger",
    file: "packages/application-control/src/ops/scheduling-config.ts",
    from: '      (kind === "weight" || (Number.isInteger(value) && value <= PG_INT_MAX));',
    to: "      (void PG_INT_MAX, true);",
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
    // The mutated tree does not compile: removing this guard is a TYPE error at its consumer, which is
    // the type system refusing to let the protocol go — enforcement stronger than a red suite, and
    // declared because an uncompilable replacement otherwise reads as a rung that tests nothing
    // (arch-review 115, classified in 119).
    compilerEnforced: true,
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
    //
    // RE-AIMED as a REGION (arch-review 63): the predicate grew a second requirement, and removing the first
    // one alone left the second independently answering `false`, so the mutation went green over a defect it
    // could no longer create. Defence in depth means no single line IS the protocol — the neutralization has
    // to remove every clause that reaches the same answer.
    name: "verifier receipt — presence of a handle passes for a join to the attempt",
    file: "packages/domain/src/execution/verifier-receipt.ts",
    from: [
      "    complete:",
      "      invocation.work?.attemptId !== undefined &&",
      "      invocation.work.verifier !== undefined &&",
      "      invocation.agentAttemptId !== undefined &&",
      "      invocation.work.verifier.agentAttemptId === invocation.agentAttemptId &&",
      '      invocation.imageProvenance?.kind === "resolved",',
    ].join("\n"),
    to: '    complete: invocation.work !== undefined && invocation.imageProvenance?.kind === "resolved",',
    build: "@everdict/domain",
    suite: ["--root", "packages/domain", "src/execution/verifier-receipt.counterexample.test.ts"],
  },
  {
    // …and the operation half: the lane's own answer used to win over the ledger's canonical row, which is
    // the reason the receipt could not be joined in the first place.
    name: "verifier operation — the lane's handle wins over the row's canonical one",
    file: "packages/application-control/src/execution/verifier-operation.ts",
    // RE-AIMED (arch-review 62 follow-through): the return grew the judged execution's attempt, so it is a
    // multi-line object now. The protocol is unchanged — prefer the lane's bare handle and the receipt
    // stops joining to the row that produced it.
    // RE-AIMED (arch-review 66): the join lives in `canonicalize`, which both the pre-reclaim
    // acknowledgement and the late fallback spend — so neutralizing it reaches every lane.
    from: "    work: persistedWork,",
    to: "    work: invocation.work ?? persistedWork,",
    build: "@everdict/application-control",
    suite: ["packages/application-control/src/execution/verifier-receipt-work.counterexample.test.ts"],
  },
  {
    // arch-review 62 P1. The staged half was keyed by the workspace, which two attempts of one case can
    // share — so the later write replaced the earlier and a recovered verdict could be merged onto another
    // execution's evidence. Key by the tree again and the two attempts collide.
    name: "agent half — the staged half is keyed by something two attempts share",
    file: "packages/application-control/src/execution/agent-half.ts",
    // RE-AIMED (arch-review 67): the digest is parse-first, so the raw call moved into `canonicalAgentHalf`.
    from: "  return contentDigest(canonicalAgentHalf(result));",
    to: "  return contentDigest(canonicalAgentHalf(result).snapshot);",
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
    // The mutated tree does not compile: removing this guard is a TYPE error at its consumer, which is
    // the type system refusing to let the protocol go — enforcement stronger than a red suite, and
    // declared because an uncompilable replacement otherwise reads as a rung that tests nothing
    // (arch-review 115, classified in 119).
    compilerEnforced: true,
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
    to: '      void reclaimInert;\n      const reclaimed = "reclaimed";',
    build: "@everdict/backends",
    suite: ["packages/backends/src/orchestrators/nomad-birth-cleanup.counterexample.test.ts"],
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
    // RE-AIMED (arch-review 66): same move — the judged execution is joined inside `canonicalize`.
    from: "    ...(job.agentAttemptId !== undefined ? { agentAttemptId: job.agentAttemptId } : {}),\n  });",
    to: "  });",
    build: "@everdict/application-control",
    suite: ["packages/application-control/src/execution/verifier-receipt-work.counterexample.test.ts"],
  },
  {
    // arch-review 63 P0. A scorecard child's row id and its execution id are different strings, and the
    // attempt ledger is keyed by the second. Reading by the first matched no row for ANY child, so every
    // batch recovery adopted nothing and re-dispatched cases whose Jobs may still have been live — the
    // inert-recovery arm and the staged-half merge were both correct and both unreachable.
    name: "batch recovery — attempts are read by the child's row id",
    file: "packages/application-control/src/scorecard/recovery-planner.ts",
    from: "          const executionId = storedExecutionId(c.executionId ?? c.id);",
    to: "          const executionId = storedExecutionId(c.id);",
    build: "@everdict/application-control",
    suite: ["packages/application-control/src/scorecard/recovery-coordinate.counterexample.test.ts"],
  },
  {
    // arch-review 63 P1-high. `committed` requires the parent to be OPEN and the terminal write is what
    // closes it, so a stamp ordered after the settle is refused every time — inside the transaction too,
    // because the guard reads the row as this transaction has left it. Put the settle back in front and
    // every successful settlement leaves its attempt open again.
    name: "settlement — the terminal write closes the door its own stamp walks through",
    file: "packages/db/src/results/run-store.ts",
    from: "    await stamp.apply(stamp.attempts);\n    const settled = await this.update(id, patch, events, guard);",
    to: "    const settled = await this.update(id, patch, events, guard);\n    await stamp.apply(stamp.attempts);",
    build: "@everdict/db",
    suite: ["packages/db/src/results/settle-stamp-order.counterexample.test.ts"],
  },
  {
    // …and the recovery half: the lane must hand the settlement WHICH attempt answered, or the stamp has
    // nothing to name and the row stays open.
    name: "recovery — the settlement is not told which attempt produced the result",
    file: "apps/api/src/composition/runtime-access.ts",
    // RE-AIMED TWICE. arch-review 63 moved the argument to `completed` (the recovered result runs the same
    // completion an in-line one does); arch-review 65 split the single coordinate into `ContributingAttempts`,
    // because a two-phase case has two producers and this argument means the AGENT's. The protocol is
    // unchanged — withhold the attempt id and the settlement has nothing to stamp, so the row stays open.
    from: "  const outcome = await service.resume(r, completed, authority, contributing.agent).catch(",
    to: "  const outcome = await service.resume(r, completed, authority).catch(",
    suite: ["--root", "apps/api", "src/composition/verifier-is-not-the-run-result.counterexample.test.ts"],
  },
  {
    // arch-review 63 P0. The in-line path runs collectDeferredTrace after the dispatch — the deferred trace
    // pull, the evidence, the observation graders, the seal — and the recovery handed the adopted result
    // straight to the settle. Skip the completion and a crash changes what was measured, not when.
    name: "recovery parity — a recovered case skips the completion an in-line one runs",
    file: "apps/api/src/composition/runtime-access.ts",
    // RE-AIMED (arch-review 64): the `.catch(() => adopted)` this used to neutralize WAS the defect — it
    // settled the pre-collection document — so the call now folds into a three-valued completion and the
    // rung neutralizes the completion itself.
    from: "      ? await deps.completeRecovered(r.tenant, r.caseSpec, adopted).then(",
    to: '      ? await Promise.resolve({ kind: "completed" as const, result: adopted }).then(',
    suite: ["--root", "apps/api", "src/composition/verifier-is-not-the-run-result.counterexample.test.ts"],
  },
  {
    // …and the retention owner, INVERTED from the previous wave: the half is owed until the settlement, so
    // discarding it at the merge is the defect. Put the discard back at the merge and the window where
    // nothing is recoverable comes back.
    name: "agent half — the merge discards a half the settlement still needs",
    file: "packages/application-control/src/execution/agent-half.ts",
    // RE-AIMED (arch-review 65): the merge returns BOTH contributing attempts now, so the return statement it
    // used to anchor on spans several lines. The neutralization is the same one — put the discard back at the
    // merge and the window in which nothing is recoverable comes back.
    from: '    kind: "merged",\n    result: mergeVerifierPass(half.result, invocation),',
    to: '    kind: "merged",\n    result: await (async () => {\n      const m = mergeVerifierPass(half.result, invocation);\n      await discardAgentHalf(store, agentHalfKey(tenant, runId, digest));\n      return m;\n    })(),',
    build: "@everdict/application-control",
    suite: ["packages/application-control/src/execution/one-recovery-protocol.counterexample.test.ts"],
  },
  {
    // arch-review 63 P1-high. The Nomad lane reclaimed after a successful start only when the caller had
    // CANCELLED. Every other post-start failure — a 5xx from /allocations, a reset connection, a poll
    // timeout — left the allocation running while this process reported a retryable infra error, and the
    // retry placed a second job.
    name: "nomad dispatch — only an abort reclaims after the start",
    file: "packages/backends/src/orchestrators/nomad.ts",
    from: '      const stopped = await this.http.request("DELETE", `/v1/job/${jobId}${delq}`).catch(() => undefined);',
    to: "      const stopped = { status: 200 };\n      void delq;",
    build: "@everdict/backends",
    suite: ["packages/backends/src/orchestrators/nomad-birth-cleanup.counterexample.test.ts"],
  },
  {
    // arch-review 63 P1-provenance. `complete` asked for the verifier's own attempt and not for the one it
    // JUDGED, so a receipt answered "which tree" while unable to say whose evidence.
    name: "verifier receipt — complete without naming the execution it judged",
    file: "packages/domain/src/execution/verifier-receipt.ts",
    from: "      invocation.agentAttemptId !== undefined &&\n      invocation.work.verifier.agentAttemptId === invocation.agentAttemptId &&",
    to: "",
    build: "@everdict/domain",
    suite: ["--root", "packages/domain", "src/execution/verifier-receipt-completeness.counterexample.test.ts"],
  },
  {
    // arch-review 63 P1. An inert object reclaimed by adoption left its attempt row reserved/active, so a
    // cancellation kept chasing an object that is gone and an operator read live work beside the re-drive.
    name: "inert reclaim — the attempt that owned the object is left open",
    file: "packages/backends/src/backend.ts",
    from: '      return { kind: "redrive", reclaimed: outcome.work };',
    to: '      return { kind: "redrive" };',
    build: "@everdict/backends",
    suite: ["packages/backends/src/orchestrators/inert-recovery.counterexample.test.ts"],
  },
  {
    // arch-review 63 P1-high. A verdict refused by the merge was left claiming it contributed.
    name: "verifier verdict — a refused merge leaves the attempt claiming it contributed",
    file: "packages/application-control/src/execution/verifier-pass.ts",
    from: '      await deps.attempts?.transition(verifierAttempt, "superseded").catch(() => undefined);',
    to: "      void verifierAttempt;",
    build: "@everdict/application-control",
    suite: ["packages/application-control/src/execution/agent-half.counterexample.test.ts"],
  },
  {
    // arch-review 63 P1-high. The Scheduler and the verifier lane shared a fit predicate and held separate
    // maps, so an agent placed a moment ago — invisible to the cluster probe until its object exists — was
    // invisible to the verifier lane, and one envelope was spent twice. Give the lane its own accounting
    // again and the two stop seeing each other.
    name: "admission — the two lanes account for what they hold separately",
    file: "apps/api/src/composition/runtime-access.ts",
    from: "  const verifiersHeld = deps.admission ?? new Admission();",
    to: "  const verifiersHeld = new Admission();",
    suite: ["--root", "apps/api", "src/composition/verifier-admission.counterexample.test.ts"],
  },
  {
    // arch-review 63 P1-high. The runtime's own runner-image credential was resolved and handed to a builder
    // whose options do not carry it. It rides the job now, where both lanes read image credentials and where
    // they are per-dispatch.
    name: "runtime credentials — the runner image's grant never reaches the dispatch",
    file: "apps/api/src/core/execution/runtime-dispatcher.ts",
    // RE-AIMED (arch-review 64): the union-minted grants come FIRST now, so the first-wins deduplication
    // downstream resolves to the credential covering every repository this pod pulls.
    from: "          ...(runnerAuths.length > 0 ? { registryAuths: [...runnerAuths, ...(job.registryAuths ?? [])] } : {}),",
    to: "",
    suite: ["--root", "apps/api", "src/core/execution/runtime-dispatcher.test.ts"],
  },
  {
    // arch-review 63 P1-adapter. `reserveWork` reads, awaits the parent check, then writes — so two callers
    // both passed and both were handed an authorization while the map kept one. Postgres admits exactly one;
    // a dev store that can reach a state production cannot lets the suite certify behaviour we do not have.
    name: "reservation — one attempt hands out two work authorizations",
    file: "packages/application-control/src/ports/execution-attempt-store.ts",
    from: "    return this.perAttempt(attemptId, () => this.reserveWorkUnsafe(attemptId, work));",
    to: "    return this.reserveWorkUnsafe(attemptId, work);",
    build: "@everdict/application-control",
    suite: ["packages/application-control/src/ports/reservation-atomicity.counterexample.test.ts"],
  },
  {
    // arch-review 63 P1. The cleanup scope opens after the create RETURNS, so a server that applied the
    // object and then lost the response left it with nobody to own it — and an inert object is not
    // terminal, so no TTL and no dead-job sweep collects it.
    //
    // PER LANE and as a REGION: this file holds two dispatches spelled alike, so a short `from` neutralizes
    // whichever appears first — which is how the first draft passed while the agent lane went untested.
    name: "k8s dispatch (agent lane) — a create whose response was lost leaves its object behind",
    file: "packages/backends/src/orchestrators/k8s.ts",
    from: [
      "      await api.applyJob(manifest, ns).catch(async (err: unknown) => {",
      "        const reclaimed = await reclaimByName(api, name, ns);",
      "        throw err instanceof AppError",
      '          ? new UpstreamError("UPSTREAM_ERROR", { ...err.extra, reclaimed }, err.message)',
      "          : new UpstreamError(",
      '              "UPSTREAM_ERROR",',
      "              { job: name, ns, reclaimed },",
      "              `the Job could not be applied: ${err instanceof Error ? err.message : String(err)}`,",
      "            );",
      "      });",
    ].join("\n"),
    to: "      await api.applyJob(manifest, ns);",
    build: "@everdict/backends",
    suite: ["packages/backends/src/orchestrators/ambiguous-create.counterexample.test.ts"],
  },
  {
    // …and the Nomad twin, which had the same window on its inert registration.
    name: "nomad dispatch — a registration whose response was lost leaves its job behind",
    file: "packages/backends/src/orchestrators/nomad.ts",
    from: "        const found = await this.findJob(jobId, ns);",
    to: '        const found = { kind: "absent" };',
    build: "@everdict/backends",
    suite: ["packages/backends/src/orchestrators/ambiguous-create.counterexample.test.ts"],
  },
  {
    // arch-review 63, found by the ExecutionId brand. Four display lookups spelled `evd-run-<row id>` by
    // hand, which is the standalone derivation — so every scorecard child's live view found no handle and
    // fell back to the case-id resolution, i.e. another concurrent trial's container. The derivation has
    // one owner now; neutralizing it back to the standalone form is what those call sites were doing.
    name: "record execution id — a child's coordinate collapses to the standalone one",
    file: "packages/contracts/src/execution/execution-id.ts",
    from: [
      "  if (record.executionId) return storedExecutionId(record.executionId);",
      "  return record.parentScorecardId",
      "    ? caseExecutionId(record.parentScorecardId, record.caseId)",
      "    : runExecutionId(record.id);",
    ].join("\n"),
    to: "  return runExecutionId(record.id);",
    build: "@everdict/contracts",
    suite: ["--root", "packages/application-control", "src/run/child-display-coordinate.counterexample.test.ts"],
  },
  {
    // arch-review 63, the fleet-permit assessment. `BackendCapacity.used` is the ONLY fleet-wide bound on a
    // backend's slots, and folding an unverifiable reading back to 0 is what let every replica admit a full
    // `total` for as long as an orchestrator outage lasted.
    name: "capacity — an unverifiable probe is spent as an empty cluster",
    file: "packages/backends/src/scheduling/scheduler.ts",
    from: [
      '  if (cap.used === "unknown") return cap.total;',
      '  return rule === "max" ? Math.max(cap.used, held) : cap.used + held;',
    ].join("\n"),
    to: [
      '  const used = cap.used === "unknown" ? 0 : cap.used;',
      '  return rule === "max" ? Math.max(used, held) : used + held;',
    ].join("\n"),
    suite: ["--root", "packages/backends", "src/scheduling/capacity-probe-unknown.counterexample.test.ts"],
  },
  {
    // …and the two PRODUCERS, because a union nothing emits is a type rather than a protocol. The probe
    // already answered `undefined` for "the query failed"; the lane threw that answer away.
    //
    // ⚠️ RE-AIMED in arch-review 68: the probe was `countActiveJobs` and became `activeUsage` when the
    // envelope grew two more axes, so this rung's `from` stopped matching. The gate reported it as a rung
    // testing nothing — which is the design, and it caught the rename in the same wave that made it.
    name: "capacity (k8s lane) — an uncountable cluster is reported idle",
    file: "packages/backends/src/orchestrators/k8s.ts",
    from: '      used: usage?.jobs ?? "unknown",',
    to: "      used: usage?.jobs ?? 0,",
    suite: ["--root", "packages/backends", "src/scheduling/capacity-probe-unknown.counterexample.test.ts"],
  },
  {
    // arch-review 68. The two axes added with the fleet envelope had a CONSUMER rung (`resource envelope`)
    // and no producer one, so a lane spending an unmeasurable reading as free room was unguarded on exactly
    // the axis the wave introduced.
    name: "capacity (k8s lane) — unmeasurable memory is reported as free room",
    file: "packages/backends/src/orchestrators/k8s.ts",
    from: '      usedMemoryMb: usage?.memoryMb ?? "unknown",',
    to: "      usedMemoryMb: usage?.memoryMb ?? 0,",
    suite: ["--root", "packages/backends", "src/scheduling/capacity-probe-unknown.counterexample.test.ts"],
  },
  {
    // …and the Nomad twin, whose fallthrough covers a 5xx as well as the throw its comment named.
    name: "capacity (nomad lane) — an unreachable cluster is reported idle",
    file: "packages/backends/src/orchestrators/nomad.ts",
    from: '      used: "unknown",',
    to: "      used: 0,",
    suite: ["--root", "packages/backends", "src/scheduling/capacity-probe-unknown.counterexample.test.ts"],
  },
  {
    // arch-review 64 P0. `collectDeferredTrace` pulls the platform trace, extracts the judge's evidence
    // slots, records the sourceTraceId, runs the deferred observation graders and seals the trajectory.
    // Three paths ran it and the batch recovery did not, so a crash changed what a scorecard child MEASURED
    // rather than only when it finished.
    name: "batch recovery — an adopted case is judged without being completed",
    file: "packages/application-control/src/scorecard/recovery-planner.ts",
    from: "            if (evalCase !== undefined) adoptable = await collectDeferredTrace(this.deps, tenant, evalCase, adoptable);",
    to: "            void evalCase;\n            void collectDeferredTrace;",
    build: "@everdict/application-control",
    suite: ["packages/application-control/src/scorecard/batch-completion-parity.counterexample.test.ts"],
  },
  {
    // arch-review 64 P1-high. `committed` means "this attempt's result is the case's answer", and the lane
    // stamped it before the merge, the collection and the settlement could each still withhold the adoption.
    // The correction for a refused merge was refused by every real store, because `committed` is terminal.
    name: "verdict phase — a produced verdict claims the case adopted it",
    file: "packages/application-control/src/execution/verifier-operation.ts",
    from: '    if (!(await attempts.transition(attemptId, "verdict_produced"))) {',
    to: '    if (!(await attempts.transition(attemptId, "committed"))) {',
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/execution/verdict-produced.counterexample.test.ts"],
  },
  {
    // …and the ADOPTION, which is what keeps the phase from being a leak. Without it every verifier row sits
    // at `verdict_produced` forever and a teardown keeps reading it as live work.
    name: "verdict phase — the run settlement does not adopt the verdict's own attempt",
    file: "packages/application-control/src/run/run-service.ts",
    // RE-AIMED (arch-review 66 P0-protocol): the settlement ADOPTS now, and consumes the answer.
    from: "                    if (adoptedVerifier !== undefined)\n                      requireAdopted(\n                        await ledger.adoptAtSettlement(adoptedVerifier, { parent, expectedExecutionId }),\n                        adoptedVerifier,\n                      );",
    to: "                    void adoptedVerifier;",
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/execution/two-attempt-settlement.counterexample.test.ts"],
  },
  {
    // arch-review 64 P0. The agent's half became durable a wave ago and the VERDICT never did, so a crash
    // between the lane's reclaim and the settlement re-ran a case whose judgement was already computed.
    name: "verdict durability — the verdict dies with the process that produced it",
    // RE-AIMED (arch-review 65): the stage moved BELOW the canonical join, and takes its coordinate as one
    // object.
    //
    // ⚠️ RE-AIMED AGAIN AT THE WRITER (arch-review 66), because the first attempt was a HOLE. arch-review 66
    // gave the lane an acknowledgement that stages BEFORE its container is reclaimed, and disabling that
    // alone does not break durability — the fallback stages the same document a moment later, which is
    // precisely what the fallback is for. The protocol this rung owns is "the verdict outlives the process
    // AT ALL", and only the write itself carries it. The ORDERING is a separate protocol with its own rung
    // (`verdict handover`), and conflating the two is how a rung ends up mutating a line whose absence
    // changes nothing.
    file: "packages/application-control/src/execution/agent-half.ts",
    // RE-AIMED (arch-review 67): the stage returns a proof rather than `void`, so its guard names the arm.
    from: '    return { kind: "absent", reason: store ? "this job staged no agent half to key a verdict by" : "no verdict store" };',
    to: '    return { kind: "absent", reason: "neutralized" };\n  if (true)\n    return { kind: "absent", reason: "neutralized" };',
    build: "@everdict/application-control",
    // The mutated tree does not compile: removing this guard is a TYPE error at its consumer, which is
    // the type system refusing to let the protocol go — enforcement stronger than a red suite, and
    // declared because an uncompilable replacement otherwise reads as a rung that tests nothing
    // (arch-review 115, classified in 119).
    compilerEnforced: true,
    suite: ["--root", "packages/application-control", "src/execution/verdict-durability.counterexample.test.ts"],
  },
  {
    // arch-review 64 P1-high. The planner adopts by the exact handle and dropped its `attemptId`, so a
    // recovered case settled with a committed receipt naming no attempt and a row still reading as live work.
    name: "batch recovery — the adopted attempt is not settled with the case",
    file: "packages/application-control/src/scorecard/recovery-planner.ts",
    // RE-AIMED (arch-review 65): the single `adoptedFrom` ref became `ContributingAttempts`, and the row this
    // stamps is the AGENT's. Withhold it and the case settles with its execution attempt still reading live.
    // RE-AIMED (arch-review 66 P0-protocol): the planner ADOPTS now, and a refusal aborts the transaction.
    from: "                        if (contributing.agent !== undefined)\n                          requireAdopted(",
    to: "                        if (false)\n                          requireAdopted(",
    build: "@everdict/application-control",
    // The mutated tree does not compile: removing this guard is a TYPE error at its consumer, which is
    // the type system refusing to let the protocol go — enforcement stronger than a red suite, and
    // declared because an uncompilable replacement otherwise reads as a rung that tests nothing
    // (arch-review 115, classified in 119).
    compilerEnforced: true,
    suite: ["packages/application-control/src/scorecard/adopted-attempt-settlement.counterexample.test.ts"],
  },
  {
    // arch-review 64 P1-high. `discardAgentHalf` had ONE production caller — the standalone recovery — while
    // the code claimed "the settlement owns the discard". Every normally-completed private-verifier case left
    // a full intermediate CaseResult in object storage forever.
    name: "intermediate GC — a settled case leaves its halves in storage forever",
    file: "packages/application-control/src/run/run-service.ts",
    // RE-AIMED (arch-review 65): the coordinate is `stagedIntermediatesOf(result)` — a ref the writing pass
    // stamps — rather than a digest dug out of the receipt, so the guard names a different local.
    // RE-AIMED (arch-review 66 P1-high): the settlement discharges what the LEDGER says this execution
    // owes, so the coordinate is no longer dug out of the recovered document.
    from: "      if (claimed !== undefined) await this.dischargeStaged(record.tenant, runExecutionId(record.id));",
    to: "      void claimed;",
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/execution/intermediate-gc.counterexample.test.ts"],
  },
  {
    // arch-review 64 P1-high. Two repository-scoped credentials for one registry host: the rendered docker
    // config kept the LAST (`auths[host] =`) while every other consumer picked the FIRST (`.find`), so one
    // of the pod's images pulled anonymously and 401'd.
    name: "registry scopes — one host renders a different credential than the system picks",
    file: "packages/domain/src/image/image-ref.ts",
    from: "    if (auths[entry.host] !== undefined) continue;",
    to: "    void entry;",
    build: "@everdict/domain",
    suite: ["--root", "packages/domain", "src/image/same-host-scopes.counterexample.test.ts"],
  },
  {
    // arch-review 64 P1. Nomad's DELETE answering 2xx means the job is marked stopped, not that the
    // allocation is gone — so the retryable rethrow re-dispatched over compute that was still terminating.
    name: "teardown convergence — a failed dispatch retries before its work is confirmed gone",
    file: "packages/backends/src/orchestrators/nomad.ts",
    from: '      const converged =\n        stopped !== undefined && stopped.status < 300 ? await this.reclaimConverged(jobId, ns) : "failed";',
    to: '      void stopped;\n      void this.reclaimConverged;\n      const converged = "reclaimed";',
    build: "@everdict/backends",
    suite: ["--root", "packages/backends", "src/orchestrators/teardown-convergence.counterexample.test.ts"],
  },
  {
    // arch-review 64 P1-adapter. `transition` reads, awaits the parent check, then writes from the stale
    // read — so a revocation landing inside that await was overwritten. Postgres cannot reach that state,
    // and nearly every counterexample in this repository runs against the in-memory twin.
    name: "attempt serialization — a commit overwrites a revocation it never saw",
    file: "packages/application-control/src/ports/execution-attempt-store.ts",
    from: "    return this.perAttempt(attemptId, () => this.transitionUnsafe(attemptId, to, patch));",
    to: "    return this.transitionUnsafe(attemptId, to, patch);",
    build: "@everdict/application-control",
    suite: ["packages/application-control/src/ports/mutation-serialization.counterexample.test.ts"],
  },
  {
    // arch-review 64 P2. A verifier lane momentarily full refuses with RATE_LIMITED, and this recorded it as
    // `tests_pass: unmeasured` — final, because `runSuite` only retries a dispatch that THREW.
    name: "transient refusal — a capacity blip settles the case permanently unjudged",
    file: "packages/application-control/src/execution/verifier-pass.ts",
    from: '    if (invocation instanceof AppError && invocation.code === "RATE_LIMITED") throw invocation;',
    to: "    void invocation;\n    void AppError;",
    build: "@everdict/application-control",
    suite: ["packages/application-control/src/execution/transient-refusal.counterexample.test.ts"],
  },
  {
    // arch-review 65 P1-high. The union pull grant was minted correctly and the ORIGINAL job was dispatched,
    // so the verifier's pod pulled its runner image with no credential. Found by `noUnusedLocals`, not by
    // review: the enriched local was computed and never read.
    name: "verifier credentials — the enriched job is computed and the original is dispatched",
    file: "apps/api/src/composition/runtime-access.ts",
    from: "          dispatched,\n          (j, hooks) => backend.dispatchVerifier(j, hooks),",
    to: "          (void dispatched, job),\n          (j, hooks) => backend.dispatchVerifier(j, hooks),",
    build: "@everdict/api",
    suite: ["--root", "apps/api", "src/composition/verifier-credentials.counterexample.test.ts"],
  },
  {
    // arch-review 65 P0. The stage held the lane's RAW answer while the normal path returned the canonical
    // one — the attempt id, the verifier coordinate and the judged execution are joined after the lane
    // answers, and `VerifierReceipt.complete` requires exactly those three. The same verifier execution read
    // `complete` in-line and `incomplete` after a crash.
    // ⚠️ RE-AIMED, AND IT WAS A HOLE FIRST (arch-review 66). The acknowledgement added a SECOND
    // `invocation: canonical,` line, textually identical to the fallback's, so this rung matched the
    // acknowledge path — which the durability suite's lane does not call. It mutated a line nobody executed
    // and read as enforcement. A rung whose `from` is not unique is aimed at whichever copy comes first.
    //
    // The production sites are named apart now (`handedOver` vs `canonical`), so this `from` is unique and
    // aims at the fallback — the path the durability suite's lane actually takes.
    name: "verdict staging — the raw wire is staged instead of the canonical invocation",
    file: "packages/application-control/src/execution/verifier-operation.ts",
    from: "        invocation: canonical,",
    to: "        invocation,",
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/execution/verdict-durability.counterexample.test.ts"],
  },
  {
    // …and the recovery's own half of it: staged bytes are ADDRESSED, not authenticated, so a document that
    // does not describe the handle recovering it is `unknown` rather than merged.
    //
    // ⚠️ THIS RUNG WAS A HOLE ON ITS FIRST RUN, and the gate said so: the suite it pointed at stages the
    // CANONICAL invocation, so no handle ever disagrees with it and removing the check changed nothing. The
    // red that file records came from the OTHER mutation (staging the raw wire), which is a different
    // protocol. The file that actually presents one execution's bytes under another's coordinate is the
    // key-identity counterexample — a rung is aimed at the suite that exercises it, not the one that
    // mentions it.
    name: "verdict recovery — staged bytes are merged without checking the handle",
    file: "packages/application-control/src/execution/agent-half.ts",
    from: "  if (mismatch)",
    to: "  void mismatch;\n  if (false)",
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/execution/verdict-key-identity.counterexample.test.ts"],
  },
  {
    // arch-review 65 P1-high. The GC coordinate was derived from the receipt, which exists only on a case that
    // settled with a COMPLETE one — so the ending that needed no help was the only one that could clean up,
    // and a verifier error, a refused merge and a retried capacity refusal each left a full intermediate
    // `CaseResult` in storage forever.
    name: "intermediate GC — the cleanup coordinate is derived from the receipt again",
    file: "packages/application-control/src/execution/agent-half.ts",
    // RE-AIMED (arch-review 66 P1-high): the coordinate is not on the document at all now — the debt is a
    // ledger row the staging writes, so neutralizing THAT is what leaves an ending owing nothing.
    from: "  await cleanup?.owe({ tenant, executionId: storedExecutionId(runId), refs: [{ key, digest }] });",
    to: "  void cleanup;",
    build: "@everdict/application-control",
    suite: [
      "--root",
      "packages/application-control",
      "src/execution/intermediate-gc-every-ending.counterexample.test.ts",
      // …and window B (arch-review 68): a half staged before any verifier reservation is discoverable ONLY
      // through this row, so neutralizing it is what makes those bytes undiscoverable.
      "src/execution/staged-half-is-discoverable.counterexample.test.ts",
    ],
  },
  {
    // arch-review 65 P0-verifier. Both recovery owners carried ONE `RuntimeWorkRef` to the settlement, and on
    // the verifier branches it was the judging container's — so the receipt named the verifier while the
    // agent's row stayed open, and a trajectory read resolved the case's evidence plane against the wrong
    // container's output.
    name: "contributing attempts — the settlement adopts the judging attempt as the execution",
    file: "apps/api/src/composition/runtime-access.ts",
    from: "  const outcome = await service.resume(r, completed, authority, contributing.agent).catch(",
    to: "  const outcome = await service.resume(r, completed, authority, contributing.verifier ?? contributing.agent).catch(",
    build: "@everdict/api",
    suite: ["--root", "apps/api", "src/composition/verifier-is-not-the-run-result.counterexample.test.ts"],
  },
  {
    // …and the BATCH owner of the same protocol. The merge returns both contributors; collapsing them back to
    // the handle the merge was reached through is the defect in the lane the api rung cannot see.
    name: "contributing attempts — the merge returns the judging handle for both halves",
    file: "packages/application-control/src/execution/agent-half.ts",
    from: "      ...(work.verifier?.agentAttemptId !== undefined ? { agent: work.verifier.agentAttemptId } : {}),\n      ...(invocation.agentAttemptId !== undefined ? { agent: invocation.agentAttemptId } : {}),",
    to: "      ...(work.attemptId !== undefined ? { agent: work.attemptId } : {}),",
    build: "@everdict/application-control",
    suite: [
      "--root",
      "packages/application-control",
      "src/scorecard/adopted-attempt-settlement.counterexample.test.ts",
    ],
  },
  {
    // arch-review 65 P1. Every component of the old key belongs to the AGENT's half, so two verifier attempts
    // judging it addressed one object — and `put` is not a conditional create. The later verdict destroyed the
    // earlier, and a recovery holding the loser's handle read the winner's bytes.
    name: "verdict key — two verifier attempts of one agent half share a key",
    file: "packages/application-control/src/execution/agent-half.ts",
    from: "  return `verifier-verdict/${tenant}/${runId}/${agentResultDigest}/${verifierAttemptId}.json`;",
    to: "  void verifierAttemptId;\n  return `verifier-verdict/${tenant}/${runId}/${agentResultDigest}.json`;",
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/execution/verdict-key-identity.counterexample.test.ts"],
  },
  {
    // arch-review 65 P2-adapter. The last mutation outside the per-attempt queue: a `transition` paused in its
    // parent check, a `markUnisolated` inside that window, and the stale `current` writes the flag back off.
    name: "attempt serialization — markUnisolated races a transition and loses the flag",
    file: "packages/application-control/src/ports/execution-attempt-store.ts",
    from: "    return this.perAttempt(attemptId, () => this.markUnisolatedUnsafe(attemptId));",
    to: "    return this.markUnisolatedUnsafe(attemptId);",
    build: "@everdict/application-control",
    suite: ["packages/application-control/src/ports/mutation-serialization.counterexample.test.ts"],
  },
  {
    // arch-review 66 P0-lifecycle. Both managed lanes reclaim their container in a `finally`, and the verdict
    // reached its durable owner only from the RETURN value — so the object was always gone before anything
    // held the bytes. Disabling the acknowledgement puts the stage back after the reclaim.
    name: "verdict handover — the verdict becomes durable only after its container is gone",
    file: "packages/application-control/src/execution/verifier-operation.ts",
    from: "      acknowledge: async (raw) => {",
    to: '      acknowledge: async (raw) => {\n        if (attemptId !== "never-an-attempt") return canonicalize(raw);',
    build: "@everdict/application-control",
    suite: [
      "--root",
      "packages/application-control",
      "src/execution/verdict-acknowledged-before-reclaim.counterexample.test.ts",
    ],
  },
  {
    // arch-review 66 P1-provenance ①. The key CONTAINS the digest and nothing re-derived it, so any
    // schema-valid CaseResult sitting at that address merged as the half the digest names.
    name: "artifact authenticity — the staged bytes are never hashed against their key",
    file: "packages/application-control/src/execution/agent-half.ts",
    from: "    if (actual !== agentResultDigest)",
    to: "    if (false)",
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/execution/artifact-authenticity.counterexample.test.ts"],
  },
  {
    // ② "present AND different → refuse" accepts omission, and `work` is optional on the schema — so the
    // cheapest forgery is a verdict that satisfies every offered comparison and declines to say where it ran.
    name: "artifact authenticity — an absent coordinate reads as a matching one",
    file: "packages/application-control/src/execution/agent-half.ts",
    from: "    stagedWork?.attemptId !== verifierAttemptId ||\n    stagedWork.externalJobId !== work.externalJobId ||\n    v.planDigest === undefined ||\n    v.workspaceDigest === undefined ||",
    to: "    (stagedWork?.attemptId !== undefined && stagedWork.attemptId !== verifierAttemptId) ||\n    (stagedWork?.externalJobId !== undefined && stagedWork.externalJobId !== work.externalJobId) ||",
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/execution/artifact-authenticity.counterexample.test.ts"],
  },
  {
    // ③ `complete: false` was a LABEL: the scores rode into the case anyway, and `tests_pass` is a reserved
    // authority metric — so a verdict nobody could attribute decided whether the case passed.
    name: "artifact authenticity — an incomplete receipt still decides the case",
    file: "packages/application-control/src/execution/agent-half.ts",
    from: "  const usable = receipt.complete === true;",
    to: "  const usable = true;",
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/execution/artifact-authenticity.counterexample.test.ts"],
  },
  {
    // arch-review 66 P1-adapter. Retrying a generation collision exactly once made a THIRD concurrent opener
    // of one execution a store fault — an ordinary race (tail speculation + spillover + retry) failing a
    // dispatch that had nothing wrong with it.
    name: "attempt mint — a third collision is treated as a store fault",
    file: "packages/db/src/results/pg-execution-attempt-store.ts",
    from: "const OPEN_COLLISION_RETRIES = 8;",
    to: "const OPEN_COLLISION_RETRIES = 2;",
    build: "@everdict/db",
    suite: ["--root", "packages/db", "src/results/attempt-mint-convergence.counterexample.test.ts"],
  },
  {
    // arch-review 66 P1-security. `CaseResult` is what a self-hosted runner submits, so a field naming objects
    // for deletion is a deletion a workspace can request. Putting it back re-opens that door.
    name: "execution boundary — the measurement document carries a cleanup instruction",
    file: "packages/contracts/src/execution/eval-case.ts",
    from: "  judgmentsSealed: z.boolean().optional(),",
    to: "  intermediates: z.object({ agentResultDigest: z.string(), verifierAttemptId: z.string().optional() }).optional(),\n  judgmentsSealed: z.boolean().optional(),",
    build: "@everdict/contracts",
    suite: ["--root", "packages/contracts", "src/execution/execution-boundary.counterexample.test.ts"],
  },
  {
    // …and the other half: a delete that did not converge marked the debt paid anyway, which is the leak one
    // call inside the ledger that was built to stop it.
    name: "intermediate debt — a failed delete discharges the debt anyway",
    file: "packages/application-control/src/ports/intermediate-cleanup-store.ts",
    from: "  if (failures.length > 0) {",
    to: "  if (false) {",
    build: "@everdict/application-control",
    // The mutated tree does not compile: removing this guard is a TYPE error at its consumer, which is
    // the type system refusing to let the protocol go — enforcement stronger than a red suite, and
    // declared because an uncompilable replacement otherwise reads as a rung that tests nothing
    // (arch-review 115, classified in 119).
    compilerEnforced: true,
    suite: [
      "--root",
      "packages/application-control",
      "src/execution/intermediate-gc-every-ending.counterexample.test.ts",
    ],
  },
  {
    // arch-review 66 P1-high · P1-security. Platform cleanup state back on the measurement document: the
    // normal and recovered documents diverge (both digests), and a self-hosted runner can name objects for
    // deletion through `submit_job_result`.
    name: "result parity — the normal path stamps cleanup state onto the case document",
    file: "packages/application-control/src/execution/verifier-pass.ts",
    from: "    return mergeVerifierPass(result, invocation as VerifierInvocation);",
    to: "    return {\n      ...mergeVerifierPass(result, invocation as VerifierInvocation),\n      intermediates: { agentResultDigest: stagedDigest },\n    } as CaseResult;",
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/execution/normal-vs-restart-parity.counterexample.test.ts"],
  },
  {
    // arch-review 67 P0-lifecycle. The verifier lane got the pre-cleanup handover in arch-review 66 and the
    // AGENT lane did not — so a crash between the backend's reclaim and the stage lost a completed agent
    // execution whose container was already gone.
    name: "agent handover — the half becomes durable only after its container is gone",
    file: "packages/application-control/src/execution/verifier-pass.ts",
    // RE-AIMED (arch-review 70 follow-through): the flag is derived from the stage's PROOF now
    // (`staged.kind === "staged"`) — neutralized back to the defect this law is about: a callback that
    // ran claiming bytes that landed, so a failed put still skips the fallback stage.
    from: '        stagedEarly = staged.kind === "staged";',
    to: "        stagedEarly = true;",
    build: "@everdict/application-control",
    // …and the suite that sees the flag's semantics is the handover-proof one: the fallback must fire
    // after a stage that wrote nothing, which the acknowledge-ordering file never drives.
    suite: ["--root", "packages/application-control", "src/execution/agent-handover-proof.counterexample.test.ts"],
  },
  {
    // arch-review 67 P2-contract. `AttemptAdoption` advertises a parent kind and id and only the epoch
    // reached a guard — two of three fields were a proof nobody consumed, inside the type introduced to fix
    // an instance of exactly that.
    name: "adoption parent identity — the parent a settlement names is never checked",
    file: "packages/application-control/src/ports/execution-attempt-store.ts",
    from: "    if (at.parent.kind !== rowParent || at.parent.id !== rowParentId)",
    to: "    if (false)",
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/scorecard/normal-settlement-adopts.counterexample.test.ts"],
  },
  {
    // arch-review 67 P1-provenance. 412 was read as idempotent success outright — "this key is occupied"
    // accepted as "the same object is there". For the verifier verdict's attempt-scoped key those are
    // different statements, and the difference is a restart reading a verdict the normal path never used.
    name: "immutable conflict — a taken key is assumed to hold the same bytes",
    file: "packages/storage/src/s3.ts",
    from: "      if (opts?.immutable !== true || status !== 412) throw err;",
    to: "      if (opts?.immutable !== true || status !== 412) throw err;\n      return await this.signedUrl(this.client, key);",
    build: "@everdict/storage",
    // The mutated tree does not compile: removing this guard is a TYPE error at its consumer, which is
    // the type system refusing to let the protocol go — enforcement stronger than a red suite, and
    // declared because an uncompilable replacement otherwise reads as a rung that tests nothing
    // (arch-review 115, classified in 119).
    compilerEnforced: true,
    suite: ["--root", "packages/storage", "src/immutable-conflict.counterexample.test.ts"],
  },
  {
    // arch-review 67 P1-adapter. The digest was taken over the RAW producer object while the read re-derives
    // it after `CaseResultSchema.parse`, so a producer whose literal differs from its parsed form staged
    // under a key its own read then refused.
    name: "agent half canonicality — the digest is taken before the schema normalizes",
    file: "packages/application-control/src/execution/agent-half.ts",
    from: "  return contentDigest(canonicalAgentHalf(result));",
    to: "  return contentDigest(result);",
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/execution/artifact-authenticity.counterexample.test.ts"],
  },
  {
    // arch-review 67 P1-high. A cancellation terminalizes the parent WITHOUT raising its epoch, so every
    // guard that checks only the epoch still passes and only the openness check refuses — which the ordinary
    // settlement was dropping on the floor. Cancelled batch, committed case, attempts that never settled.
    name: "settlement adoption — a cancelled parent is treated as one still driving",
    file: "packages/application-control/src/ports/execution-attempt-store.ts",
    from: "        if (!parent || !(OPEN_SCORECARD_STATUSES as readonly string[]).includes(parent.status)) return undefined;",
    to: "        void OPEN_SCORECARD_STATUSES;\n        if (!parent) return undefined;",
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/scorecard/normal-settlement-adopts.counterexample.test.ts"],
  },
  {
    // arch-review 70 P1. `owe` reopened a settled row unconditionally, so a late speculative loser dragged a
    // completed execution back into `retained` — a state `due()` never returns.
    name: "cleanup retention — a late loser reopens a settled execution's debt",
    file: "packages/application-control/src/ports/intermediate-cleanup-store.ts",
    from: '      state: prior !== undefined && prior.state !== "retained" ? "gc_owed" : "retained",',
    to: '      state: "retained",',
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/ports/every-ending-releases.counterexample.test.ts"],
  },
  {
    // arch-review 70 P1. The inline discharge removed every released ref without reading `written`, while the
    // reconciler refused exactly those — one ref, two meanings.
    name: "artifact convergence — the inline discharge deletes what it never confirmed",
    file: "packages/application-control/src/ports/intermediate-cleanup-store.ts",
    from: "    const state = await evaluateRef(ref, deps.probe);",
    to: '    const state = "written" as const;\n    void evaluateRef;',
    build: "@everdict/application-control",
    // The mutated tree does not compile: removing this guard is a TYPE error at its consumer, which is
    // the type system refusing to let the protocol go — enforcement stronger than a red suite, and
    // declared because an uncompilable replacement otherwise reads as a rung that tests nothing
    // (arch-review 115, classified in 119).
    compilerEnforced: true,
    suite: ["--root", "packages/application-control", "src/ops/artifact-write-convergence.counterexample.test.ts"],
  },
  {
    // arch-review 70 P0. `stagedEarly` recorded that the stage had been CALLED, so a refused put produced a
    // successful acknowledgement AND skipped the fallback. Restoring the boolean reproduces both.
    name: "agent handover — the stage is believed rather than read",
    file: "packages/application-control/src/execution/verifier-pass.ts",
    from: '        stagedEarly = staged.kind === "staged";',
    to: "        stagedEarly = true;",
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/execution/agent-handover-proof.counterexample.test.ts"],
  },
  {
    // arch-review 70 P0. The policy existed and the composition never passed it, so every deployment took
    // the permissive default. Dropping the spread is exactly the production state of two waves.
    name: "durability policy — the composition judges without choosing what a loss costs",
    file: "apps/api/src/composition/runtime-access.ts",
    from: "            ...(deps.durability ? { durability: deps.durability } : {}),",
    to: "            ...{},",
    suite: ["--root", "apps/api", "src/composition/durability-policy-is-chosen.counterexample.test.ts"],
  },
  {
    // arch-review 70 P1. The release was a second commit, so a crash in the gap left the row `retained` —
    // a state `due()` never returns, on an execution that is already terminal.
    name: "settlement release — the debt is freed in a second commit",
    file: "packages/db/src/results/pg-run-store.ts",
    from: "      if (release !== undefined) await release.apply(new PgIntermediateCleanupStore(tx));",
    to: "      void release;\n      void PgIntermediateCleanupStore;",
    build: "@everdict/db",
    suite: ["--root", "apps/api", "src/trust/settlement-release-atomicity.trust.test.ts"],
    env: { EVERDICT_TRUST_SUITE: "1" },
    requiresEnv: ["EVERDICT_TRUST_DATABASE_URL"],
  },
  {
    // arch-review 69 P2. The discharge used to spell the row's name itself (`gc-${executionId}`) while the Pg
    // adapter mints `gc/${tenant}/${executionId}`, so every inline-cleanup failure deferred against no row.
    // Re-introducing the caller-side spelling is exactly the production state; only real Postgres can see it,
    // because the in-memory twin spelled it the same way the caller did.
    name: "cleanup backoff — the caller spells the row's identity instead of reading it",
    file: "packages/application-control/src/ports/intermediate-cleanup-store.ts",
    from: '      .deferred(released.operationId, failures.join("; "), new Date(Date.now() + 60_000).toISOString())',
    to: '      .deferred(`gc-${executionId}`, failures.join("; "), new Date(Date.now() + 60_000).toISOString())',
    build: "@everdict/application-control",
    suite: ["--root", "apps/api", "src/trust/intermediate-cleanup.trust.test.ts"],
    env: { EVERDICT_TRUST_SUITE: "1" },
    requiresEnv: ["EVERDICT_TRUST_DATABASE_URL"],
  },
  {
    // arch-review 69 P1. The verdict's cleanup debt reached the ledger only if the composition passed one,
    // and for two waves it did not — while the agent half's lane did. Removing the spread reproduces the
    // production state exactly: bytes written, no row, nothing that can ever find them.
    name: "verdict debt — the composition judges without handing over a ledger",
    file: "apps/api/src/composition/runtime-access.ts",
    from: "            ...(deps.cleanup ? { cleanup: deps.cleanup } : {}),",
    to: "            ...{},",
    suite: ["--root", "apps/api", "src/composition/verdict-debt-is-wired.counterexample.test.ts"],
  },
  {
    // arch-review 69 P0. The Scheduler rebuilds the dispatch options out of `QueueEntry`, and a field nobody
    // adds to that rebuild is dropped in silence. `acknowledgeResult` was the second to die there. The rung
    // is aimed at the ORDER the option exists to produce, not at the copy: a field assertion would pass the
    // moment somebody re-adds the line and say nothing about whether the handover still precedes the reclaim.
    name: "dispatch options — the durable handover dies in the scheduler's allowlist",
    file: "packages/backends/src/scheduling/scheduler.ts",
    from: "            ...(entry.acknowledgeResult ? { acknowledgeResult: entry.acknowledgeResult } : {}),",
    to: "            ...{},",
    build: "@everdict/backends",
    suite: ["--root", "apps/api", "src/core/execution/acknowledge-through-scheduler.counterexample.test.ts"],
  },
  {
    // arch-review 68. Memory and CPU were bounded PER PROCESS ONLY — declared envelopes with nothing
    // observing allocation, so two replicas holding one 4 GiB budget could each reserve 3 GiB. Folding only
    // this process's accounting puts that back.
    name: "resource envelope — the observed reading is ignored and only this process counts",
    file: "packages/backends/src/scheduling/scheduler.ts",
    from: '  if (observed === undefined) return ours;\n  if (observed === "unknown") return budget;\n  return Math.max(observed, ours);',
    to: "  void budget;\n  void observed;\n  return ours;",
    build: "@everdict/backends",
    suite: ["--root", "packages/backends", "src/scheduling/fleet-resource-envelope.counterexample.test.ts"],
  },
  {
    // arch-review 68. The safety property of the whole ledger: a sweep that can see RETAINED rows deletes the
    // artifact a crashed case is about to be recovered from, which turns the cleanup into a way of destroying
    // the recovery it exists to enable.
    name: "cleanup sweep — a retained artifact is handed to the reconciler",
    file: "packages/application-control/src/ports/intermediate-cleanup-store.ts",
    from: '          (d.state === "gc_owed" || d.state === "retry_wait") &&',
    to: '          d.state !== "completed" &&',
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/ops/cleanup-reconciler.counterexample.test.ts"],
  },
  {
    // …and the same predicate in the adapter that actually runs it. Real Postgres, because the guard IS the
    // SQL — the in-memory twin proves the shape and this proves the deployment.
    name: "cleanup sweep (postgres) — a retained artifact is handed to the reconciler",
    file: "packages/db/src/results/pg-intermediate-cleanup-store.ts",
    from: "        WHERE state IN ('gc_owed', 'retry_wait')\n          AND (next_attempt_at IS NULL",
    to: "        WHERE state <> 'completed'\n          AND (next_attempt_at IS NULL",
    build: "@everdict/db",
    suite: ["--root", "apps/api", "src/trust/intermediate-cleanup.trust.test.ts"],
    env: { EVERDICT_TRUST_SUITE: "1" },
    requiresEnv: ["EVERDICT_TRUST_DATABASE_URL"],
  },
  {
    // arch-review 68. `owe` records the debt BEFORE the put, so a ref can name bytes that do not exist —
    // and deleting an absent key succeeds on every object store. Counting it done completes a debt whose put
    // is still in flight behind it, orphaning the object the row exists to protect.
    name: "cleanup sweep — an unwritten ref is counted deleted",
    file: "packages/application-control/src/ops/intermediate-cleanup-reconciler.ts",
    // RE-AIMED (arch-review 70 P1): the guard became the shared evaluator (`evaluateRef`) — neutralized
    // so every ref reads as written, and the sweep deletes-and-counts a debt whose put never landed.
    from: "        const state = await evaluateRef(ref, this.deps.probe);",
    to: '        const state = await evaluateRef(ref, this.deps.probe).then((s) => (s ? "written" : s));',
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/ops/cleanup-reconciler.counterexample.test.ts"],
  },
  {
    // arch-review 67 P1-high. The ledger existed, the tests wired it, and the production dispatcher had no
    // parameter to carry it — so every production private-verifier case staged artifacts nothing owed.
    name: "cleanup wiring — the dispatcher drops the ledger on its way to the pass",
    file: "apps/api/src/core/execution/verifier-aware-dispatcher.ts",
    from: "      ...(this.cleanup ? { cleanup: this.cleanup } : {}),",
    to: "      ...(this.cleanup ? {} : {}),",
    build: "@everdict/api",
    suite: ["--root", "apps/api", "src/composition/cleanup-is-wired.counterexample.test.ts"],
  },
  {
    // arch-review 67 P0-lifecycle. The acknowledgement's ordering was right and its guarantee was empty: it
    // swallowed its own store write and reported success, so an unwritable verdict was handed over as
    // durable and the lane reclaimed the container that could have re-produced it.
    name: "verdict durability policy — an unwritable verdict is acknowledged as durable",
    file: "packages/application-control/src/execution/verifier-operation.ts",
    from: '  const requiresDurableVerdict = deps.durability === "required";',
    to: "  const requiresDurableVerdict = false;",
    build: "@everdict/application-control",
    suite: [
      "--root",
      "packages/application-control",
      "src/execution/verdict-acknowledged-before-reclaim.counterexample.test.ts",
    ],
  },
  {
    // arch-review 67 P1-high. The debt was written as `owed` — the state that means DELETE THIS — from the
    // moment the bytes were staged, so wiring a reconciler would have deleted the artifact the case still
    // needed. Retention and deletion are two states.
    name: "cleanup lifecycle — a staged artifact is collectable before its case settles",
    file: "packages/application-control/src/ports/intermediate-cleanup-store.ts",
    // RE-AIMED (arch-review 70 P1): the birth line carries the loser-reopen guard now — the protocol under
    // test is still the RETAINED birth (a staged artifact is not collectable before its case settles).
    from: '      state: prior !== undefined && prior.state !== "retained" ? "gc_owed" : "retained",',
    to: '      state: "gc_owed",',
    build: "@everdict/application-control",
    suite: [
      "--root",
      "packages/application-control",
      "src/execution/intermediate-gc-every-ending.counterexample.test.ts",
    ],
  },
  {
    // arch-review 67 P0-canonicality. The ambiguous arm read the receipt ledger for EXISTENCE and then seeded
    // the process-local document — so a concurrent writer's different result for the same child left the
    // batch carrying something the ledger does not hold, silently.
    name: "commit readback — the recovery seeds its own result over the persisted one",
    file: "packages/application-control/src/scorecard/recovery-planner.ts",
    from: "                  seed.push(readBack.result);",
    to: "                  seed.push(adoptedResult);",
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/scorecard/ambiguous-commit.counterexample.test.ts"],
  },
  {
    // …and the corroboration itself: a receipt whose child cannot back it is not a tie to break in favour of
    // whoever is asking.
    name: "commit readback — a receipt the child contradicts is accepted anyway",
    file: "packages/application-control/src/scorecard/commit-readback.ts",
    from: "  if (actual !== vouched)",
    to: "  if (false)",
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/scorecard/ambiguous-commit.counterexample.test.ts"],
  },
  {
    // arch-review 66 P1-lifecycle. `.catch(() => undefined)` made a commit whose RESPONSE was lost
    // indistinguishable from one that never happened, and the planner re-dispatched the case — duplicate
    // compute for a case that had already settled.
    name: "ambiguous commit — a lost response is read as a case that never committed",
    file: "packages/application-control/src/scorecard/recovery-planner.ts",
    from: '            if (adoption.kind === "unknown") {',
    to: '            if (adoption.kind === "unknown" && false) {',
    build: "@everdict/application-control",
    // The mutated tree does not compile: removing this guard is a TYPE error at its consumer, which is
    // the type system refusing to let the protocol go — enforcement stronger than a red suite, and
    // declared because an uncompilable replacement otherwise reads as a rung that tests nothing
    // (arch-review 115, classified in 119).
    compilerEnforced: true,
    suite: ["--root", "packages/application-control", "src/scorecard/ambiguous-commit.counterexample.test.ts"],
  },
  {
    // arch-review 66 P0-protocol, in-memory twin. The same guard the SQL carries — comparing the parent's
    // current epoch against the epoch the attempt was OPENED under, which a recovery's own claim has raised.
    name: "recovery adoption — the in-memory guard compares the opening epoch",
    file: "packages/application-control/src/ports/execution-attempt-store.ts",
    from: "      if (authority.epoch !== at.parent.adoptingEpoch)",
    to: "      if (authority.epoch !== current.driverEpoch)",
    build: "@everdict/application-control",
    suite: [
      "--root",
      "packages/application-control",
      "src/scorecard/settlement-adopts-its-attempts.counterexample.test.ts",
    ],
  },
  {
    // arch-review 66 P0-protocol. `PARENT_AUTHORIZES` matches the parent's CURRENT epoch against the epoch the
    // attempt was OPENED under — right for a lane still running, backwards for a recovery, whose claim raises
    // that epoch. Comparing against `driver_epoch` again makes every recovery-adopted attempt unadoptable,
    // which is the production defect: canonical outcome committed over refused writes.
    name: "recovery adoption — the guard asks about the opening epoch instead of the adopting one",
    file: "packages/db/src/results/pg-execution-attempt-store.ts",
    from: "                AND s.owner_epoch = $3::int",
    to: "                AND (a.driver_epoch IS NULL OR s.owner_epoch = a.driver_epoch)",
    build: "@everdict/db",
    suite: ["--root", "apps/api", "src/trust/recovery-adoption.trust.test.ts"],
    env: { EVERDICT_TRUST_SUITE: "1" },
    requiresEnv: ["EVERDICT_TRUST_DATABASE_URL"],
  },
  {
    // arch-review 68. The conditional create is what makes an "immutable" artifact immutable, and every
    // repair that rests on it was certified against a mocked 412. Removing the header leaves that mocked
    // counterexample 4/4 GREEN — verified — while a real endpoint accepts the overwrite, which is precisely
    // why this rung is aimed at the scenario that talks to one.
    name: "immutable artifact — the conditional create never reaches the endpoint",
    file: "packages/storage/src/s3.ts",
    from: '          ...(opts?.immutable === true ? { IfNoneMatch: "*" } : {}),',
    to: "          ...{},",
    build: "@everdict/storage",
    suite: ["--root", "apps/api", "src/trust/intermediate-artifacts.trust.test.ts"],
    env: { EVERDICT_TRUST_SUITE: "1" },
    requiresEnv: ["EVERDICT_TRUST_S3_ENDPOINT", "EVERDICT_TRUST_S3_ACCESS_KEY", "EVERDICT_TRUST_S3_SECRET_KEY"],
  },
  {
    // evolution-lineage Track A. The ancestry was in hand (`RepinResult.base` answers it to the caller) and
    // dropped at the write — `register(tenant, next, subject)` with no origin, which is the exact pre-fix
    // call shape this mutation restores. The counterexample drives the production composition (the real
    // service over the real in-memory registry) and must go red.
    name: "Track A — the re-pin registers its successor without the merge-base origin",
    file: "packages/application-control/src/harness/harness-pin-service.ts",
    from: '    from: { type: "harness", id, version: base.version },',
    to: "",
    build: "@everdict/application-control",
    suite: ["--root", "packages/registry", "src/harness/harness-pin-lineage.counterexample.test.ts"],
  },
  {
    // evolution-lineage Track A follow-through (save_agent). A bump's ancestor is known only at this write;
    // dropping the stamp reverts the agent family to versions with no succeeds lineage — the counterexample
    // asserting the bump's origin must notice.
    name: "Track A — the agent save stops stamping the base its bump succeeds",
    file: "apps/api/src/core/agent/agent-service.ts",
    from: '      const stamped: CapabilityOrigin = { ...origin, from: { type: "agent", id, version: latest.version } };',
    to: "      const stamped: CapabilityOrigin = { ...origin };",
    suite: ["--root", "apps/api", "src/api/capability-origin.routes.test.ts"],
  },
  {
    // evolution-lineage Track C follow-through. The seal is what makes a re-score read the same observations
    // the in-run judges saw; dropping the push leaves the channel live-only and the durable-document law
    // broken again. The seal counterexample must notice.
    name: "Track C — the observation channel is no longer sealed into the trace",
    file: "packages/application-execution/src/run-case.ts",
    from: "    trace.push(...observationTraceEvents(observationsOf()));",
    to: "    void observationTraceEvents;",
    build: "@everdict/application-execution",
    suite: ["--root", "packages/application-execution", "src/run-case-observations.counterexample.test.ts"],
  },
  {
    // evolution-lineage Track C. The observation channel exists so the judgment can weigh the world's own
    // account; a channel that reports `sampled` while dropping the deltas is the emptiest form of the
    // annotation defect — present, and carrying nothing. The run-case counterexample must notice.
    name: "Track C — the sampled observation channel drops its deltas",
    file: "packages/application-execution/src/run-case.ts",
    from: '    return { kind: "sampled", deltas: [...envDeltas] };',
    to: '    return { kind: "sampled", deltas: [] };',
    build: "@everdict/application-execution",
    suite: ["--root", "packages/application-execution", "src/run-case-observations.counterexample.test.ts"],
  },
  {
    // review wave C. A declared origin naming its own family would mint the version-lineage `succeeds`
    // edge for a derivation that never happened — only the platform's re-pin/bump writes may say it (L3).
    name: "wave C — a register may declare its own family as its origin",
    file: "apps/api/src/api/capability-origin.ts",
    from: "  if (from !== undefined && from.type === self.type && from.id === self.id) {",
    to: "  if (false && from !== undefined && from.type === self.type && from.id === self.id) {",
    suite: ["--root", "apps/api", "src/api/capability-origin.routes.test.ts"],
  },
  {
    // …and the re-pin preserves the team that owns the harness: detached from the base's row, the
    // successor becomes the newest own version with no owner and re-files the entity out of its team.
    // ⚠️ RE-AIMED (arch-review 106). Both lanes used to resolve the team themselves and pass it to
    // `register` — a read-then-write with a window an ownership transfer fits through — and each carried its
    // own rung on its own read. arch-review 92 replaced BOTH with `registerPreservingOwner`, which resolves
    // the owner INSIDE the write, so the two subjects those rungs named no longer exist and the gate refused
    // them (a mutation whose target is gone FAILS, which is the check working). The protocol is now one
    // mechanism, so it gets one rung on that mechanism — neutralize the resolution and every lane that
    // depends on it must go red.
    // ── THE THREE DOORS THAT MINT A VERSION ALL ASK WHOSE ENTITY IT IS (arch-review 117-118) ────────
    //
    // `registerPreservingOwner` preserves an owner; being ALLOWED to write to that owner is a different
    // question, and three doors mint versions through it. arch-review 76 gated the adoption door and did not
    // look at its siblings — the re-pin gated the action without a resource, the agent save gated neither
    // transport. A gate that exists on one door and not the others is the one-lane-only shape this whole
    // series is about, so each door gets its own rung.
    name: "R118 — the agent save door mints a version without asking whose agent it is",
    file: "apps/api/src/api/agent/agent.routes.ts",
    from: '      gate(principal, "agents:write", owner);',
    to: '      gate(principal, "agents:write");',
    suite: ["--root", "apps/api", "src/api/capability-origin.routes.test.ts"],
  },
  {
    // …and the MCP twin, because BFF↔MCP parity is structural (rule `api-layer`) and a gate one transport
    // carries and the other does not is exactly how this defect reached production.
    name: "R118 — the MCP save door mints a version without asking whose agent it is",
    file: "apps/api/src/api/agent/agent.mcp.ts",
    // ⚠️ The formatter split `}, owner);` across lines, so the rung names the ARGUMENT — the thing whose
    // absence is the defect — rather than a punctuation shape a formatter owns.
    from: "          owner,",
    to: "",
    suite: ["--root", "apps/api", "src/api/agent/agent-save.mcp.test.ts"],
  },
  {
    // The re-pin door's half: the service forwards what the transport gated on, and dropping the forward
    // silently restores the window (arch-review 117).
    name: "R117 — the re-pin drops the owner its authorization was granted against",
    file: "packages/application-control/src/harness/harness-pin-service.ts",
    from: "    ...(authority !== undefined ? ([authority] as const) : ([] as const)),",
    to: "",
    build: "@everdict/application-control",
    suite: ["--root", "packages/registry", "src/harness/harness-pin-lineage.counterexample.test.ts"],
  },
  {
    // ── A VERDICT READS THE PAYLOAD, NOT ITS PREVIEW (arch-review 120) ────────────────────────────
    //
    // The offload leaves an EXCERPT plus a ref where an oversized value was. Asking for the bytes back was
    // OPTIONAL, and the owned-trace ingest did not ask — six lines under a comment saying "it is scoring the
    // trace, not showing it", while the re-score path in the same file passed the flag with a comment saying
    // why. Neutralizing the exact collector back to the plain one is that defect exactly.
    // Aimed at the DEFINITION rather than the call site: neutralizing the call would leave an unused import
    // and the tree would not build, which says nothing about the protocol (rule `ci`, the uncompilable-rung
    // split). Here the removal is exactly "stop asking for the bytes", and it compiles.
    name: "payload offload — the owned-trace scorecard judges the preview",
    file: "packages/application-control/src/ports/trajectory-store.ts",
    from: "  return collectTrajectoryEvents(store, tenant, runId, { ...window, resolve: true });",
    to: "  return collectTrajectoryEvents(store, tenant, runId, { ...window });",
    build: "@everdict/application-control",
    suite: ["--root", "apps/api", "src/core/scorecard/exact-offloaded-scoring.counterexample.test.ts"],
  },
  {
    name: "wave C — a successor is registered without the team its entity is owned by",
    file: "packages/registry/src/versioned-store.ts",
    // ⚠️ RE-AIMED TWICE, and the second time because THE PROTOCOL MOVED DOWN A LAYER (arch-review 119).
    //
    // 115 gave the write an `authority` precondition, so the resolution and its fallback moved onto one line
    // and this rung followed them. Then `register` itself learned that silence PRESERVES an entity's owner —
    // a successor can no longer be born detached even when its caller passes nothing — and neutralizing
    // `registerPreservingOwner`'s spelling stopped changing the outcome. The gate said so: HOLE, the suite
    // stayed green with the protocol removed.
    //
    // That is the fix working, not the rung failing. The question "can a successor forget whose entity it is"
    // is now answered one layer down, so the rung asks it there. A rung left aimed at the old line would have
    // gone on reporting a protocol nothing tests.
    from: "    const effectiveTeamId = owner ?? teamId;",
    to: "    const effectiveTeamId = teamId;",
    build: "@everdict/registry",
    suite: ["--root", "packages/registry", "src/owner-preserving-register.counterexample.test.ts"],
  },
  {
    // …and the agent bump rides the same resolution, on the transport an owner actually uses.
    name: "wave C — the agent bump detaches from its entity's owning team",
    file: "packages/registry/src/versioned-store.ts",
    from: "      if (entry.deletedAt === undefined && entry.teamId !== undefined) return entry.teamId;",
    to: "      if (entry.deletedAt === undefined && entry.teamId !== undefined) return undefined;",
    build: "@everdict/registry",
    suite: ["--root", "apps/api", "src/api/capability-origin.routes.test.ts"],
  },
  {
    // …and the MCP pin tool authorizes against the entity's owning team (BFF↔MCP parity) — read from the
    // wrong id, the gate sees an unowned resource and lets an outsider re-pin another team's harness.
    name: "wave C — the MCP pin gate reads the wrong entity's team",
    file: "apps/api/src/api/harness/harness.mcp.ts",
    from: "        const owner = await teamOfEntity(instances, ws, id);",
    to: '        const owner = await teamOfEntity(instances, ws, "");',
    suite: ["--root", "apps/api", "src/mcp.test.ts"],
  },
  {
    // review wave B. The observation channel cannot be forged from after the seal: the sealer writes its
    // samples then ONE marker, and the in-job platform pull appends foreign bytes after it — the reader
    // takes the FIRST marker and counts only samples before it. Removing the break restores last-wins.
    name: "wave B — the reader lets a post-seal marker override the platform's seal",
    file: "packages/domain/src/observation/observation-trace.ts",
    from: "      break; // first marker wins — a later one was appended after the seal",
    to: "      // (break removed — last marker wins)",
    build: "@everdict/domain",
    suite: ["--root", "packages/domain", "src/observation/observation-trace.test.ts"],
  },
  {
    // …and the harness's own stream may not spell the reserved vocabulary — the strip at the drain is the
    // boundary. Neutralized, a forged `sampled` account seals into the trace as the platform's.
    name: "wave B — the boundary stops stripping the forged channel from the harness stream",
    file: "packages/application-execution/src/run-case.ts",
    from: "        if (isReservedObservationEvent(ev)) continue;",
    to: "        if (false && isReservedObservationEvent(ev)) continue;",
    build: "@everdict/application-execution",
    suite: ["--root", "packages/application-execution", "src/run-case-observations.counterexample.test.ts"],
  },
  {
    // …and a foreign span spelling `everdict.env_action = platform_observation_*` is demoted at the mapper,
    // never promoted into the channel's voice.
    name: "wave B — the span mapper promotes a forged observation action",
    file: "packages/domain/src/trace/spans-to-events.ts",
    from: "      !isReservedObservationAction(asText(a[EVERDICT_ATTR.envAction]))",
    to: '      !isReservedObservationAction("")',
    build: "@everdict/domain",
    suite: ["--root", "packages/domain", "src/trace/span-event-bridge.test.ts"],
  },
  {
    // …and the re-score reads the observations the RUN sealed — detached from the trace, every deferred
    // judgment silently downgrades to no_environment while the in-line one saw the samples.
    name: "wave B — the re-score detaches from the sealed observations",
    file: "packages/application-control/src/execution/scoring-service.ts",
    from: "      observations: observationsFromTrace(result.trace),",
    to: "      observations: observationsFromTrace([]),",
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/execution/scoring-service.test.ts"],
  },
  {
    // …and the push ingest strips the reserved vocabulary at the door — unstripped, an uploaded trace
    // scores (and seals) a fabricated `sampled` account as the platform's own.
    name: "wave B — the push ingest accepts a trace speaking in the platform's voice",
    file: "packages/application-control/src/scorecard/scorecard-ingest-service.ts",
    from: "    const traces = input.traces.map((t) => ({ ...t, trace: stripReservedObservationEvents(t.trace) }));",
    to: "    const traces = input.traces.map((t) => ({ ...t, trace: stripReservedObservationEvents(t.trace.slice(0, 0)).concat(t.trace) }));",
    build: "@everdict/application-control",
    suite: ["--root", "apps/api", "src/server.test.ts"],
  },
  {
    // evolution-lineage Track D (review follow-through). The settle's gate answer is computed over the rounds
    // it read — the close CAS must fence that count, or a concurrent round makes the sealed answer stale.
    // The SQL-pin suite must notice the fence leaving the statement.
    name: "Track D — the close CAS stops fencing the round count",
    file: "packages/db/src/evolution/campaign-store.ts",
    from: "         WHERE tenant=$1 AND id=$2 AND state='open' AND jsonb_array_length(rounds) = $6",
    to: "         WHERE tenant=$1 AND id=$2 AND state='open'",
    build: "@everdict/db",
    suite: ["--root", "packages/db", "src/evolution/campaign-store.test.ts"],
  },
  {
    // …and the service must REFUSE identity drift, not record it: a candidate scorecard that evaluated a
    // different version than the declared one is a mislabeled request (L3). The service suite must notice.
    name: "Track D — the round accepts a candidate the scorecard never evaluated",
    file: "packages/application-control/src/evolution/campaign-service.ts",
    from: "    if (candidateHarness.version !== input.candidateVersion)",
    to: "    if (false && candidateHarness.version !== input.candidateVersion)",
    build: "@everdict/application-control",
    suite: ["--root", "packages/db", "src/evolution/campaign-store.test.ts"],
  },
  {
    // …and a confound (an axis VERIFIED different) may never read as a comparable round.
    name: "Track D — a confounded comparison is filed as comparable",
    file: "packages/application-control/src/evolution/campaign-service.ts",
    from: "  if (confoundedAxes.length > 0)",
    to: "  if (confoundedAxes.length > 9999)",
    build: "@everdict/application-control",
    suite: ["--root", "packages/db", "src/evolution/campaign-store.test.ts"],
  },
  {
    // evolution-lineage Track D. Zero significant regressions is half the adoption bar; dropping it lets a
    // candidate that broke a case ship on the strength of the cases it helped. The gate suite must notice.
    //
    // ⚠️ RE-AIMED in arch-review 71: adoption authority moved to the HELD-OUT population, so the counts this
    // bar is about are `held.*` now. The invariant is unchanged and its line moved — which is exactly the
    // failure the gate reports rather than silently testing nothing.
    name: "Track D — the adoption gate stops requiring zero regressions",
    file: "packages/domain/src/evolution/campaign-gate.ts",
    from: "  return held.improvements >= 1 && held.regressions === 0;",
    to: "  return held.improvements >= 1;",
    build: "@everdict/domain",
    suite: ["--root", "packages/domain", "src/evolution/campaign-gate.test.ts"],
  },
  {
    // evolution-lineage Track D. The identity refusal is what keeps an optimization verdict off an
    // unverifiable world; neutralizing the check adopts over it with no recorded waiver.
    name: "Track D — the adoption gate adopts over an unverified world identity",
    file: "packages/domain/src/evolution/campaign-gate.ts",
    from: "    if (unverified.length > 0 && !frame.allowUnverifiedIdentity) {",
    to: '    if (unverified.length > 0 && !frame.allowUnverifiedIdentity && frame.subject.id === "") {',
    build: "@everdict/domain",
    suite: ["--root", "packages/domain", "src/evolution/campaign-gate.test.ts"],
  },
  {
    // arch-review 73. The byte-naming refusal is what keeps `adopt` from being an answer nothing can
    // authorize: a round whose scorecard sealed no manifest names a version LABEL, and a close over it
    // carries no operation — arch-review 71's abolished state. The decision belongs to the gate because the
    // waiver is a frozen frame declaration (rule `suite`); refusing at the proof minter instead is what
    // reopened the hole, so this rung aims at the gate.
    name: "R73 — the adoption gate adopts a candidate whose bytes it cannot name",
    file: "packages/domain/src/evolution/campaign-gate.ts",
    from: "    if (latest.verdict.candidateSpecDigest === undefined && !frame.allowLabelOnlyAdoption) {",
    to: '    if (latest.verdict.candidateSpecDigest === undefined && !frame.allowLabelOnlyAdoption && frame.subject.id === "") {',
    build: "@everdict/domain",
    suite: ["--root", "packages/domain", "src/evolution/adopted-implies-authorization.counterexample.test.ts"],
  },
  {
    // arch-review 73. `completed` means the adoption's INTENT settled — the issue it was opened against
    // closed ON THIS ADOPTION'S EVIDENCE. The join is the scorecard the proof names; without it any
    // resolution nearby completes the operation, which records that this adoption discharged an intent it
    // did not (rule `protocol` L3, in its tracker-shaped form).
    name: "R73 — an adoption completes on any resolution, not on its own evidence",
    file: "packages/application-control/src/evolution/adoption-completion-watch.ts",
    // ⚠️ RE-AIMED (arch-review 106): arch-review 84 moved this comparison into `adoption-completion.ts` —
    // the module both writers import so neither imports the other — and the inline spelling is gone.
    from: "        if (!issueSettledThisAdoption(settled, operation.proof)) continue;",
    to: "        void issueSettledThisAdoption;\n        if (false) continue;",
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/evolution/adoption-completion.counterexample.test.ts"],
  },
  {
    // arch-review 75. The coverage requirement is read from the POLICY; nesting it under the data made a
    // frame demanding 50% coverage satisfiable by a round with no observations block at all. Neutralizing
    // the policy-first entry must be caught, or "an absence is not a clean bill of health" is prose again.
    name: "R75 — a coverage requirement is skipped when the round recorded nothing",
    file: "packages/domain/src/evolution/campaign-gate.ts",
    from: "  if (need !== undefined) {",
    to: "  if (need !== undefined && obs !== undefined) {",
    build: "@everdict/domain",
    suite: ["--root", "packages/domain", "src/evolution/held-out-authority.counterexample.test.ts"],
  },
  {
    // arch-review 75. A legacy frame may be READ and may not DECIDE. Neutralizing the eligibility guard
    // lets a campaign stored with one held-out scenario log a fresh round — which BUILDS the held-out block
    // the rule exists to require — and adopt on it.
    name: "R75 — a legacy frame is allowed to produce new adoption evidence",
    file: "packages/application-control/src/evolution/campaign-service.ts",
    from: "    const defects = campaignFrameDefects(record.frame);",
    to: "    const defects = campaignFrameDefects(record.frame).slice(0, 0);",
    build: "@everdict/application-control",
    suite: ["--root", "packages/db", "src/evolution/campaign-store.test.ts"],
  },
  {
    // Review of the evolution loop (2026-09-02). The frame's two endings — budget spent, rejected streak — were
    // ANSWERED by the gate and enforced by nobody: `logRound` appended past both, and the gate read the latest
    // round for a win before either ending, so a driver that never asked `decision` could log until a round
    // happened to win and adopt at a level the pre-registered family never covered. The write refuses now;
    // handing the refusal an empty trace is the neutralization, and the service suite must notice.
    name: "Evolve — a round past the frame's own ending is appended",
    file: "packages/application-control/src/evolution/campaign-service.ts",
    from: "    const ended = campaignRoundRefusal(record.frame, record.rounds);",
    to: "    const ended = campaignRoundRefusal(record.frame, record.rounds.slice(0, 0));",
    build: "@everdict/application-control",
    suite: ["--root", "packages/db", "src/evolution/campaign-store.test.ts"],
  },
  {
    // …and the gate's half: a round logged after the ending is not evidence, whatever it scored.
    name: "Evolve — the gate reads a win before it reads the frame's ending",
    file: "packages/domain/src/evolution/campaign-gate.ts",
    from: "  const ended = campaignStoppedAt(frame, rounds);",
    to: "  const ended = campaignStoppedAt(frame, rounds.slice(0, 0));",
    build: "@everdict/domain",
    suite: ["--root", "packages/domain", "src/evolution/campaign-gate.test.ts"],
  },
  {
    // …and a trace whose LAST budgeted round won, followed by rounds the write should have refused (rows from
    // before the refusal existed): the over-budget tail is not evidence either.
    name: "Evolve — the gate adopts over a trace that exceeds the budget",
    file: "packages/domain/src/evolution/campaign-gate.ts",
    from: "  if (rounds.length > frame.budget.maxRounds)",
    to: "  if (rounds.length > frame.budget.maxRounds + 9999)",
    build: "@everdict/domain",
    suite: ["--root", "packages/domain", "src/evolution/campaign-gate.test.ts"],
  },
  {
    // Caller-authored round fields are bounded by the RECORD's schema at the write, whichever door they came
    // through — the MCP tool carried no bounds and Postgres decodes every row on read, so one over-long finding
    // made a workspace's campaign list unreadable. Neutralized by parsing nothing.
    name: "Evolve — a round the stored row cannot decode is appended",
    file: "packages/application-control/src/evolution/campaign-service.ts",
    from: "    const bounded = CampaignRoundInputSchema.safeParse(input);",
    to: "    const bounded = CampaignRoundInputSchema.partial().safeParse({});",
    build: "@everdict/application-control",
    suite: ["--root", "packages/db", "src/evolution/campaign-store.test.ts"],
  },
  {
    // The judges that SCORED a side are read from the scoring ledger's current revision; reading only the
    // batch-only submit pin rejected every ingested round under a frame that pinned its judges.
    name: "Evolve — the judge check reads the submit pin an ingested record never has",
    file: "packages/application-control/src/evolution/campaign-service.ts",
    from: "      (side.record.scoring?.at(-1)?.judges ?? side.record.orchestration?.judges ?? [])",
    to: "      (side.record.orchestration?.judges ?? [])",
    build: "@everdict/application-control",
    suite: ["--root", "packages/db", "src/evolution/campaign-store.test.ts"],
  },
  {
    // Coverage's denominator is the judge family: a cost or a step count cannot carry an assessment, and
    // counting them made `minimumCoverage` unreachable for the loop the policy was written for.
    name: "Evolve — observation coverage counts scores no judge could have assessed",
    file: "packages/application-control/src/evolution/campaign-service.ts",
    from: "      if (!isJudgeFamilyMetric(sc.metric)) continue;",
    to: '      if (sc.metric === "" && !isJudgeFamilyMetric(sc.metric)) continue;',
    build: "@everdict/application-control",
    suite: ["--root", "packages/db", "src/evolution/campaign-store.test.ts"],
  },
  {
    // A halted sibling's rounds were spent against the same held-out rows; a family arithmetic that counted
    // ancestors only let a second successor of the same predecessor overspend it.
    name: "Evolve — the chain's family forgets a sibling branch",
    file: "packages/application-control/src/evolution/campaign-service.ts",
    from: "    for (const c of everyCampaign) if (tree.has(c.id) && !seen.has(c.id)) spent += c.rounds.length;",
    to: "    for (const c of everyCampaign) if (tree.has(c.id) && !seen.has(c.id)) spent += 0 * c.rounds.length;",
    build: "@everdict/application-control",
    suite: ["--root", "packages/db", "src/evolution/campaign-store.test.ts"],
  },
  {
    // The adopt route gates the campaign's OWN team; gating on the proof's copy let a proof with the field
    // stripped skip the gate and fail on its digest as a 409 where a member of another team owes a 403.
    name: "Evolve — the adopt route gates the team the caller wrote on the proof",
    file: "apps/api/src/api/campaign/campaign.routes.ts",
    from: '      gate(principal, "scorecards:run", campaign.teamId !== undefined ? { teamId: campaign.teamId } : {});',
    to: '      gate(principal, "scorecards:run", body.proof.teamId !== undefined ? { teamId: body.proof.teamId } : {});',
    suite: ["--root", "apps/api", "src/api/campaign/campaign.routes.test.ts"],
  },
  {
    // code-evolution-loop.md D3. A candidate whose pull request touched the frame's oracle paths rewrote its own
    // exam; the round is non-comparable whatever it scored. Neutralizing the refusal files it as a win, and the
    // service suite must notice.
    name: "Evolve — a candidate that touched the oracle scope is filed as comparable",
    file: "packages/application-control/src/evolution/campaign-service.ts",
    from: '  if (oracle?.kind === "touched")',
    to: '  if (oracle?.kind === "touched" && oracle.paths.length < 0)',
    build: "@everdict/application-control",
    suite: ["--root", "packages/db", "src/evolution/campaign-store.test.ts"],
  },
  {
    // code-evolution-loop.md D5. A chain continues a result; an adoption whose pull request is still a branch
    // has registered bytes the default branch does not hold. Neutralizing the guard lets the successor open,
    // and the service suite must notice.
    name: "Evolve — a chain continues an adoption whose code is still a branch",
    file: "packages/application-control/src/evolution/campaign-service.ts",
    from: '    if (parentOperation?.code !== undefined && parentOperation.code.state !== "merged")',
    // `state` is `owed | merged`, so excluding both is a condition that never fires and still type-checks — the
    // SUITE is what refuses, not the compiler (rule `ci`, the two kinds of uncompilable rung).
    to: '    if (parentOperation?.code !== undefined && parentOperation.code.state !== "merged" && parentOperation.code.state !== "owed")',
    build: "@everdict/application-control",
    suite: ["--root", "packages/db", "src/evolution/campaign-store.test.ts"],
  },
  {
    // code-evolution-loop.md D6. A round under a budgeted frame is refused when its delegation session ran past
    // the TTL the frame allows; neutralizing the bound logs it, and the service suite must notice.
    name: "Evolve — a delegation past the frame's budget is logged",
    file: "packages/application-control/src/evolution/campaign-service.ts",
    from: "      if (ttlSec > budget.ttlSec)",
    to: "      if (ttlSec > budget.ttlSec * 1e9)",
    build: "@everdict/application-control",
    suite: ["--root", "packages/db", "src/evolution/campaign-store.test.ts"],
  },
  {
    // code-evolution-loop.md D2. Everdict builds the candidate into its own store; a failed build must settle
    // the record `failed`, not leave a dangling `building` row nobody converges. Neutralizing the fail write
    // leaves it building, and the service suite must notice.
    name: "Evolve — a failed build leaves its record building",
    file: "packages/application-control/src/evolution/campaign-build-service.ts",
    from: "      await this.deps.builds",
    to: "      if (false) await this.deps.builds",
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/evolution/campaign-build-service.counterexample.test.ts"],
  },
  {
    // …and Everdict's own build account outranks the scorecard origin (D2): the candidate's provenance is the
    // commit Everdict observed, not the caller's coordinates. Neutralizing the preference reads the origin.
    name: "Evolve — the round prefers the caller's origin over Everdict's build account",
    file: "packages/application-control/src/evolution/campaign-service.ts",
    from: "  const candidateSource = builtSource ?? candidateSourceOf(snapshot.candidate);",
    // A `void` fingerprint, not the bare fallback: the bare line is one an HONEST earlier commit carried before
    // the build account existed, and `pnpm mutation-leak` matches `to:` text against every commit ahead of the
    // remote — a neutralization spelled like a plausible line accuses history it never touched.
    to: "  const candidateSource = (void builtSource, candidateSourceOf(snapshot.candidate));",
    build: "@everdict/application-control",
    suite: ["--root", "packages/db", "src/evolution/campaign-store.test.ts"],
  },
  {
    // D2 meets D3. The oracle reads the pull request Everdict's build record names before the scorecard
    // origin's — a driver-submitted batch carries none, so reading the origin alone makes every Everdict-built
    // candidate "unverifiable" under an oracle scope. Neutralizing the preference reads the origin.
    name: "Evolve — the oracle reads the caller's origin over Everdict's build account",
    file: "packages/application-control/src/evolution/campaign-service.ts",
    from: "    const source = builtSource ?? candidateSourceOf(snapshot.candidate);",
    to: "    const source = (void builtSource, candidateSourceOf(snapshot.candidate));",
    build: "@everdict/application-control",
    suite: ["--root", "packages/db", "src/evolution/campaign-store.test.ts"],
  },
  {
    // L2 on the build ledger. A read that failed is not a ledger with no build in it; neutralizing the refusal
    // turns an outage into "no build", and the round goes in wearing the caller's provenance.
    name: "Evolve — an unreadable build ledger reads as no build",
    file: "packages/application-control/src/evolution/campaign-service.ts",
    from: "      .catch(unreadableBuildLedger(campaignId, candidateVersion));",
    to: "      .catch(() => (void unreadableBuildLedger, []));",
    build: "@everdict/application-control",
    suite: ["--root", "packages/db", "src/evolution/campaign-store.test.ts"],
  },
  {
    // evolution-routing-spec.md §3. A frame with targets adopts only when every target flipped; neutralizing the
    // rule falls back to the aggregate held-out block, and the gate suite must notice.
    name: "Evolve — a targeted frame adopts on the aggregate while a target still fails",
    file: "packages/domain/src/evolution/campaign-gate.ts",
    from: "  if (frame.targets.length > 0) {",
    to: "  if (frame.targets.length < 0) {",
    build: "@everdict/domain",
    suite: ["--root", "packages/domain", "src/evolution/campaign-gate.test.ts"],
  },
  {
    // benchmark-evidence-spec.md §3. A round names its evidence by key + digest; the read serves the bytes only
    // when they still digest to the seal. Neutralizing the check serves tampered bytes as the round's evidence,
    // and the db campaign suite must notice.
    name: "Evolve — the evidence read serves bytes that do not digest to the round's seal",
    file: "packages/application-control/src/evolution/campaign-service.ts",
    from: "    if (contentDigest(document) !== ref.digest)",
    to: "    if (contentDigest(document) !== ref.digest && ref.digest.length < 0)",
    build: "@everdict/application-control",
    suite: ["--root", "packages/db", "src/evolution/campaign-store.test.ts"],
  },
  {
    // harness-identity-and-seeds-spec.md §4. A candidate seeded with knowledge born from the frame's held-out
    // cases is not comparable; neutralizing the refusal logs it as a win, and the db campaign suite must notice.
    name: "Evolve — a candidate seeded with the exam's findings is filed as comparable",
    file: "packages/application-control/src/evolution/campaign-service.ts",
    from: '  if (seedLeak.kind === "leak")',
    to: '  if (seedLeak.kind === "leak" && seedLeak.seeds.length < 0)',
    build: "@everdict/application-control",
    suite: ["--root", "packages/db", "src/evolution/campaign-store.test.ts"],
  },
  {
    // code-review pass 1 over evidence spec §2. An invalidated producer score keeps its `judge:*` name and detail;
    // only a MEASURED judge score is a judge's word. Neutralizing the status check reads the producer's diagnosis.
    name: "Evolve — a producer's invalidated judge score is read as a diagnosis",
    file: "packages/domain/src/evolution/diagnosis.ts",
    from: '    if (score.status !== undefined && score.status !== "measured") continue;',
    to: '    if (score.status !== undefined && score.status !== "measured" && score.status.length < 0) continue;',
    build: "@everdict/domain",
    suite: ["--root", "packages/domain", "src/evolution/diagnosis.test.ts"],
  },
  {
    // code-review pass 1 over identity spec §2. A private seed belongs to its author; neutralizing the visibility
    // rule seeds any member's private skill into any run that names it.
    name: "Evolve — a private seed is materialized for a run its author did not submit",
    file: "packages/application-control/src/harness/harness-seeds.ts",
    from: '  return record.visibility === "workspace" || (subject !== undefined && record.createdBy === subject);',
    to: '  return record.visibility === "workspace" || record.visibility === "private" || (subject !== undefined && record.createdBy === subject);',
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/harness/harness-seeds.test.ts"],
  },
  {
    // evolution-routing-spec.md §4. The set's mint rests on the claim; neutralizing it lets two drivers finishing
    // the last member both mint, and the build-set counterexample must notice.
    name: "Evolve — a build set mints without its claim",
    file: "packages/application-control/src/evolution/campaign-build-service.ts",
    from: '    if (claim !== "claimed") return this.getSet(tenant, setId);',
    to: '    if (claim !== "claimed" && claim.length < 0) return this.getSet(tenant, setId);',
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/evolution/campaign-build-service.counterexample.test.ts"],
  },
  {
    // …and the members' observed commits must agree, or the pull request moved between builds and the version
    // would carry two different heads under one name.
    name: "Evolve — a build set mints over two different observed commits",
    file: "packages/application-control/src/evolution/campaign-build-service.ts",
    from: "    if (shas.length !== 1 || sha === undefined)",
    to: "    if (sha === undefined)",
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/evolution/campaign-build-service.counterexample.test.ts"],
  },
  {
    // arch-review 76 P0. The digest is proved BEFORE the immutable write; neutralizing that puts the proof
    // back after it, which poisons the label with bytes the campaign never measured and makes the honest
    // retry impossible forever. The counterexample asserts the WORLD, not just the refusal.
    name: "R76 — the adoption proves its digest only after the irreversible write",
    file: "apps/api/src/composition/campaign-adoption.ts",
    from: "        if (measured !== undefined && would !== measured) refuseDigest(would);",
    to: "        // MUTATED: the proof moves back after the write",
    suite: ["--root", "apps/api", "src/composition/adoption-is-spent.counterexample.test.ts"],
  },
  {
    // arch-review 76 P1-high. The registration side of the completion join. Without it an issue resolved
    // before the adoption landed leaves the operation `registered` forever — the E1 cursor advanced past
    // the only event that would have completed it.
    name: "R76 — only one ordering of the completion join is owned",
    file: "packages/application-control/src/evolution/campaign-adoption-service.ts",
    // ⚠️ RE-AIMED (arch-review 106): the call gained the `causedBy` argument when the completion learned to
    // stamp the agent that caused it, so the old exact line no longer exists.
    from: "    const completed = await this.completeIfIntentSettled(input.tenant, operation, causedByOf(input.agent));",
    to: "    const completed = undefined;",
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/evolution/adoption-consumes-proof.counterexample.test.ts"],
  },
  {
    // arch-review 76 P1. Physical attempts terminal is not the case terminal; dropping the child join
    // collects the artifacts a retry still needs.
    name: "R76 — a terminal attempt is read as a terminal case",
    file: "apps/api/src/composition/retained-disposition.ts",
    from: '    const unknown = dispositions.find((d) => d.kind === "unknown");',
    to: '    return { kind: "terminal" };\n    const unknown = dispositions.find((d) => d.kind === "unknown");',
    suite: ["--root", "apps/api", "src/composition/logical-terminal.counterexample.test.ts"],
  },
  {
    // arch-review 77. The successor's owning team is resolved INSIDE the write; the caller-read spelling
    // leaves a window an ownership transfer fits through, and the entity's versions then come apart — the
    // split `teamOfVersion` was made required to prevent.
    name: "R77 — a successor is filed under a team the caller read earlier",
    file: "packages/registry/src/versioned-store.ts",
    // ⚠️ RE-AIMED (arch-review 119). R77 closed the WRITER's window by resolving the owner here; 115 closed
    // the AUTHORIZER's by asserting the owner the gate was granted against. Both rungs pointed at the same
    // vanished line, which made them one test wearing two names — so this one now neutralizes the
    // PRECONDITION and the sibling above neutralizes the resolution. Two windows, two rungs.
    from: "      current !== authority.expectedOwnerTeamId",
    to: "      false",
    build: "@everdict/registry",
    suite: ["--root", "packages/registry", "src/owner-preserving-register.counterexample.test.ts"],
  },
  {
    // evolution-lineage Track B. The kubelet's imageID observation is what resolves a mutable tag; dropping
    // the read reverts the lane to `unresolved{lane_cannot_report}` for every unpinned reference, and the
    // world axis then degrades exactly where drift is most likely. The dispatch counterexample must notice.
    name: "Track B — the K8s lane stops reading the kubelet's image observation",
    file: "packages/backends/src/orchestrators/k8s.ts",
    // RE-AIMED (review wave B): the read wears its best-effort catch now — the observation is enrichment
    // and a rejecting probe may not destroy the completed result it decorates.
    from: "          const observed = await api.podImageIds(name, ns).catch(() => undefined);",
    to: "          const observed = undefined;",
    build: "@everdict/backends",
    suite: ["--root", "packages/backends", "src/orchestrators/k8s-image-observation.counterexample.test.ts"],
  },
  {
    // evolution-lineage Track A. A recorded same-family origin IS the version lineage; collapsing the
    // succeeds arm back into born_from leaves the `succeeds` predicate declared-but-dead again — the state
    // the whole track exists to end. The harvest suite must notice.
    name: "Track A — the harvester files a same-family origin as born_from instead of succeeds",
    file: "packages/domain/src/knowledge/harvest-specs.ts",
    from: "      if (ft.data === self.type && from.id === self.key && hasVersion) {",
    to: '      if (ft.data === self.type && from.id === self.key && hasVersion && from.id === "") {',
    build: "@everdict/domain",
    suite: ["--root", "packages/domain", "src/knowledge/harvest-specs.test.ts"],
  },
  {
    // ── LONG-HORIZON TRACE READS (docs/architecture/long-horizon-trace-reads.md) ────────────────────
    //
    // R0. The run detail's cost badge is answered by a summary the WRITER derived, never by reading the
    // trajectory. Making it touch the evidence store's expensive door is the defect verbatim: hundreds of
    // megabytes through two full parses, in a process every workspace shares, for five numbers.
    name: "OOM — the cost badge reads a body again",
    file: "packages/application-control/src/run/run-service.ts",
    from: "    const answer = await this.deps.trajectories.usage(record.tenant, record.id).catch(() => undefined);",
    to: "    await this.deps.trajectories.events(record.tenant, record.id, {});\n    const answer = await this.deps.trajectories.usage(record.tenant, record.id).catch(() => undefined);",
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/run/trajectory-usage-without-body.counterexample.test.ts"],
  },
  {
    // R2 prerequisite. `spansToEvents` reads `base` and `perCallTokens` off the WHOLE array, so a page
    // projected on its own restarts the `t` axis and double-counts an aggregate span's tokens. Ignoring the
    // plane's recorded facts is that defect, and it changes the llm_call COUNT — a number that reaches an
    // invoice.
    name: "OOM — the projection measures a page against itself",
    file: "packages/domain/src/trace/spans-to-events.ts",
    from: "  const { baseMs: base, perCallTokens } = opts.batch ?? spanBatchFacts(sorted);",
    to: "  const { baseMs: base, perCallTokens } = spanBatchFacts(sorted);",
    build: "@everdict/domain",
    suite: ["--root", "packages/domain", "src/trace/paged-projection.counterexample.test.ts"],
  },
  {
    // …and the WIRING half of the same rule: the facts only reach a page because the seal records them. A
    // pure test cannot see a store that stopped writing them.
    name: "OOM — the seal stops recording the plane's batch facts",
    file: "packages/application-control/src/ports/trajectory-store.ts",
    from: "      batch: spanBatchFacts(spans),",
    to: "      ...(false ? { batch: spanBatchFacts(spans) } : {}),",
    build: "@everdict/application-control",
    suite: ["--root", "packages/db", "src/results/paged-read.counterexample.test.ts"],
  },
  {
    // R2. A page that can come back EMPTY because its first event alone exceeds the byte budget is a stream
    // that never advances — the caller asks again from the same cursor, forever. Bounding one event is the
    // offload's job; the pager's job is to keep making progress.
    name: "OOM — a byte budget is allowed to return an empty page",
    file: "packages/application-control/src/ports/trajectory-store.ts",
    from: "    if (slice.length > 0 && bytes + size > maxBytes) break;",
    to: "    if (bytes + size > maxBytes) break;",
    build: "@everdict/application-control",
    suite: ["--root", "packages/db", "src/results/paged-read.counterexample.test.ts"],
  },
  {
    // R2. A plane sealed before mig 0200 is one blob and a window of a blob costs the whole blob, so the
    // store REFUSES above its ceiling. Serving it instead is the OOM; serving an empty page would be worse,
    // because every reader takes that as a run that did nothing.
    name: "OOM — an oversized legacy body is served instead of refused",
    file: "packages/db/src/results/trajectory-store.ts",
    from: "    if (storedBytes > MAX_LEGACY_BODY_BYTES)",
    to: "    if (storedBytes > MAX_LEGACY_BODY_BYTES && false)",
    build: "@everdict/db",
    suite: ["--root", "packages/db", "src/results/paged-read.counterexample.test.ts"],
  },
  {
    // R1. A page of a hundred events is only a bound if the events are bounded. Leaving every payload inline
    // is the half windowing cannot do.
    name: "OOM — an oversized payload is never moved out of the event",
    file: "packages/application-control/src/ports/offloading-trajectory-store.ts",
    from: "    if (value === undefined || value === null) return undefined;",
    to: "    if (value === undefined || value === null) return undefined;\n    return undefined;",
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/ports/payload-offload.counterexample.test.ts"],
  },
  {
    // R1. A resolve was ASKED for, so a preview is not an acceptable answer to it — a judge handed an excerpt
    // under the name of the whole scores different evidence and nothing downstream can tell.
    name: "OOM — a missing offloaded payload degrades into the preview",
    file: "packages/application-control/src/ports/offloading-trajectory-store.ts",
    from: "    if (bytes === undefined)",
    to: "    if (bytes === undefined) return undefined;\n    if (false)",
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/ports/payload-offload.counterexample.test.ts"],
  },
  {
    // R120. Every ceiling downstream of this store is in BYTES; the offload measured its own in UTF-16 code
    // units, so a Korean trace kept 3x the intended payload inline and a field under the code-unit ceiling
    // was never moved at all.
    name: "the inline ceiling is measured in code units, not bytes",
    file: "packages/application-control/src/ports/offloading-trajectory-store.ts",
    from: '    const bytes = Buffer.byteLength(value, "utf8");',
    to: "    const bytes = value.length;",
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/ports/payload-offload.counterexample.test.ts"],
  },
  {
    // R120. The budget is the FIELD's and it is CARRIED: a bag of two hundred medium leaves has no leaf over
    // the ceiling, and stayed inline at megabytes — one event defeating every page bound downstream.
    // RE-AIMED (design review): the greedy budget was replaced by max-min fair allocation, so the old target
    // line no longer exists. Giving each field's walk a FRESH whole budget is the same neutralization in the
    // new spelling — the per-field ceiling stops bounding the field.
    name: "the inline budget is per leaf instead of per field",
    file: "packages/application-control/src/ports/offloading-trajectory-store.ts",
    from: "  const share = fairShare(sizes, totalBudget);",
    to: "  const share = (void fairShare, void totalBudget, EVENT_INLINE_MAX);",
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/ports/payload-offload.counterexample.test.ts"],
  },
  {
    // R120 design review. The doc's invariant — "every key and every small value survives" — is the one that
    // was right: a greedy budget lets the first leaf take everything, so the same bag previews differently
    // depending on JSON key order and a small sibling becomes "".
    name: "the preview budget is spent first-come, so key order decides",
    file: "packages/application-control/src/ports/offloading-trajectory-store.ts",
    from: "  const cursor = { index: 0 };\n  return applyPreview(value, share, cursor);",
    to: "  const cursor = { index: 0 };\n  return applyPreview(value, share === 0 ? 0 : totalBudget, cursor);",
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/ports/payload-offload.counterexample.test.ts"],
  },
  {
    // R120 self-review. `.catch(() => 0)` made an outage observationally identical to a quiet hour, in the
    // one sweep that now throws on purpose so the rows naming payload objects survive for the next pass.
    name: "a retention outage is reported as a clean sweep",
    file: "packages/application-control/src/ops/retention-sweep.ts",
    from: '    return { kind: "swept", removed: await deleteOlderThan(cutoffIso) };',
    to: '    return { kind: "swept", removed: await deleteOlderThan(cutoffIso).catch(() => 0) };',
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/ops/retention-sweep.counterexample.test.ts"],
  },
  {
    // R120 self-review. `deferCompletion` is a conditional write that exists to answer `false`, and its only
    // caller discarded the boolean — so a deferral that never landed read as one that did, and the rows the
    // backoff was written for kept the head of the worklist forever with nothing to see.
    name: "the deferral's answer is discarded by its only caller",
    file: "packages/application-control/src/evolution/adoption-completion-reconciler.ts",
    from: '      if (outcome !== "completed" && !(await this.defer(operation, outcome, now))) out.undeferred += 1;',
    to: '      if (outcome !== "completed") void (await this.defer(operation, outcome, now));',
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/evolution/deferral-answer-consumed.counterexample.test.ts"],
  },
  {
    // R120 self-review. The offloaded payload tier was reachable only by internal scoring: neither transport
    // forwarded `resolve` and no route dereferences a trajectory payload ref, so "show me the evidence the
    // judge read" was unanswerable for exactly the payloads big enough to have been moved.
    name: "the transport cannot ask for the sealed payload",
    file: "apps/api/src/api/trajectory/trajectory.routes.ts",
    from: "        ...(resolve ? { resolve: true } : {}),",
    to: "        ...(resolve ? {} : {}),",
    build: "@everdict/api",
    suite: ["--root", "apps/api", "src/api/trajectory/offloaded-payload-is-reachable.counterexample.test.ts"],
  },
  {
    // R122. A ref pin the record can HOLD but no API call can SET is a policy nobody can adopt — the
    // capability-declared-and-undeliverable shape, one layer above what `unwired-capabilities` scans for.
    name: "the ci link upsert drops the ref pin",
    file: "packages/application-control/src/ci-link/ci-link-service.ts",
    from: "      ...(body.refs !== undefined ? { refs: body.refs } : {}),",
    to: "      ...(body.refs !== undefined ? {} : {}),",
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/ci-link/ci-ref-roundtrip.counterexample.test.ts"],
  },
  {
    // R122. The secret store decrypts "injection-only" — a member never sees a workspace secret, the platform
    // injects it. That holds while the DESTINATION is trustworthy, and a remote MCP capability's destination
    // is a URL `capabilities:write` (member+) lets the same member author, while the value is guarded by
    // `secrets:write` (admin). Binding without the entitlement is exfiltration with extra steps.
    name: "a member binds a workspace secret to a destination they chose",
    file: "apps/api/src/core/agent/agent-member-tooling-service.ts",
    from: "  return [...new Set(Object.values(bindings))].filter((bound) => shared.has(bound)).sort();",
    to: "  return (void shared, void bindings, []);",
    build: "@everdict/api",
    suite: ["--root", "apps/api", "src/core/agent/workspace-secret-binding.counterexample.test.ts"],
  },
  {
    // R122. The CI trust policy decided on repository alone while the token's `ref` was parsed and discarded,
    // and `ci` carries `harnesses:register` (the merge-time re-pin) plus `scorecards:run` — so branch-push
    // access to the linked repo was register-and-spend access on the workspace.
    name: "the CI trust policy ignores the ref the token was minted on",
    file: "packages/domain/src/auth/ci-trust.ts",
    from: "      refAllowed(link.refs ?? [], claims.ref),",
    to: "      (void refAllowed, void link.refs, void claims.ref, true),",
    build: "@everdict/domain",
    suite: ["--root", "packages/domain", "src/auth/ci-ref-authority.counterexample.test.ts"],
  },
  {
    // R122. `run_id` is the PK of the trajectories table and `(run_id, emitter)` of the segments — neither key
    // carries the workspace. The read checked the HEADER's tenant and returned every row it found, so the
    // isolation of the READ lived in the WRITE path's guard.
    name: "the plane read filters the header's workspace but not the rows'",
    file: "packages/db/src/results/trajectory-store.ts",
    // ⚠️ The `to:` is a DISTINCTIVE full line, not a prefix of the real one. Dropping the clause outright
    // leaves `… WHERE run_id = $1`, which is a prefix of the fixed line AND of a sibling query — so
    // `pnpm mutation-leak` matched a clean commit and reported a leak that was not there. A neutralization is
    // also a FINGERPRINT: it has to be text no legitimate line contains. `$2 = $2` defeats the filter, keeps
    // the parameter bound, and cannot occur by accident.
    from: "         FROM everdict_trajectory_segments WHERE run_id = $1 AND tenant = $2",
    to: "         FROM everdict_trajectory_segments WHERE run_id = $1 AND $2 = $2",
    build: "@everdict/db",
    suite: ["--root", "packages/db", "src/results/plane-tenant-scope.counterexample.test.ts"],
  },
  {
    // R122. The runner's deep-track door took the WHOLE track union, which carries `frames` — and a frame is
    // a ref the run-detail read re-signs into a browser-facing presigned URL, over one bucket shared by the
    // whole deployment. The door's own description already named the right set; the schema did not agree.
    name: "the producer track door accepts a frame coordinate",
    file: "packages/contracts/src/execution/recording.ts",
    from: 'export const ProducerTrackEntrySchema = z.discriminatedUnion("track", PRODUCER_TRACKS);',
    to: 'export const ProducerTrackEntrySchema = z.discriminatedUnion("track", [FRAMES_TRACK, ...PRODUCER_TRACKS]);',
    build: "@everdict/contracts",
    suite: ["--root", "packages/contracts", "src/execution/producer-track.counterexample.test.ts"],
  },
  {
    // R122. `traceRef` arrives on a producer's document, and the control plane resolved ITS named secret and
    // sent it to ITS named endpoint — arbitrary workspace-secret exfiltration, and SSRF from the control
    // plane, for anyone who can register a runtime or a harness. The registered pool is the authority.
    name: "a producer names the secret and the endpoint for deferred collection",
    file: "packages/application-control/src/execution/collect-trace.ts",
    from: "        if (!declares)",
    to: "        if (void declares, false)",
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/execution/traceref-authority.counterexample.test.ts"],
  },
  {
    // R122. `CaseResult` is the MEASUREMENT and two of its fields are the CONTROL PLANE's statements about
    // it. `provenance` decides who pays — a forged one bills nobody, or bills a victim workspace and drains
    // its budget — and `verifier` is the private verifier's receipt. The self-hosted lane overwrote
    // provenance by accident of order; the managed lane never touched it, and a workspace supplies the
    // job-runner image that prints the sentinel.
    name: "a producer stamps the control plane's own facts on the measurement",
    file: "packages/contracts/src/execution/eval-case.ts",
    from: "  for (const field of PLATFORM_STAMPED_RESULT_FIELDS) delete copy[field];",
    to: "  void PLATFORM_STAMPED_RESULT_FIELDS;",
    build: "@everdict/contracts",
    suite: ["--root", "packages/contracts", "src/execution/untrusted-case-stamps.counterexample.test.ts"],
  },
  {
    // R121. `EnvSnapshot.screenshotRef`/`domRef` are the same shape one document up, and sharper: the read
    // path re-signs them into a browser-facing presigned URL, and the artifact bucket is ONE bucket for the
    // deployment. A producer naming a key would be handed a signed URL that leaves our authorization behind.
    name: "a producer names an object for us to presign",
    file: "packages/contracts/src/execution/trace.ts",
    from: '    if (typeof held === "string" && held.startsWith(ARTIFACT_REF_SCHEME)) delete copy[field];',
    to: "    void held;\n    void ARTIFACT_REF_SCHEME;",
    build: "@everdict/contracts",
    suite: ["--root", "packages/contracts", "src/execution/untrusted-case-result.counterexample.test.ts"],
  },
  {
    // R121. The producer-facing schema must not carry the platform's artifact coordinates. Without the strip
    // a forged `outputRef` reaches the seal, and from there both readers — a resolve that fetches it and a
    // retention sweep that deletes it.
    name: "the untrusted door accepts a platform-authored artifact coordinate",
    file: "packages/contracts/src/execution/trace.ts",
    from: "  for (const field of PLATFORM_AUTHORED_EVENT_FIELDS) delete copy[field];",
    to: "  void PLATFORM_AUTHORED_EVENT_FIELDS;",
    build: "@everdict/contracts",
    suite: ["--root", "packages/contracts", "src/execution/untrusted-trace.counterexample.test.ts"],
  },
  {
    // R121. Every other ceiling on this path became real in this wave; the collector scoring actually calls
    // was bounded by nothing — it pages politely and pushes every event into one array, so peak heap is the
    // whole trace and one case's long-horizon run takes the shared control plane down with it.
    name: "the collected trace is unbounded in memory",
    file: "packages/application-control/src/ports/trajectory-store.ts",
    from: "    if (held > limitBytes)",
    to: "    if (void held, void limitBytes, false)",
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/ports/collected-trace-bound.counterexample.test.ts"],
  },
  {
    // R121. The string-leaf budget bounds text and nothing else: four hundred thousand numbers, or twenty
    // thousand long keys, have no leaf over any share and stayed inline whole. The windowed read's premise
    // is that ONE event is bounded, and for every shape that is not text it was not.
    name: "a structure whose bytes are not in strings is left unbounded",
    file: "packages/application-control/src/ports/offloading-trajectory-store.ts",
    from: "    const structure = boundStructure(strings.preview, STRUCTURE_INLINE_MAX);",
    to: "    const structure = (void boundStructure, void STRUCTURE_INLINE_MAX, { preview: strings.preview, truncated: false });",
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/ports/payload-offload.counterexample.test.ts"],
  },
  {
    // R121. A resolved page was bounded in EVENTS only, and an offloaded event's stored size is its preview
    // — so fifty of them clear every stored-byte ceiling and still materialize hundreds of megabytes.
    name: "a resolved page is bounded in events but not in bytes",
    file: "packages/application-control/src/ports/offloading-trajectory-store.ts",
    from: "      if (resolved.length > 0 && spent + size > MAX_RESOLVED_PAGE_BYTES)",
    to: "      if (resolved.length > 0 && (void MAX_RESOLVED_PAGE_BYTES, void spent, void size, false))",
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/ports/payload-offload.counterexample.test.ts"],
  },
  {
    // R121. `TraceEvent` is the schema a producer's submission is validated by, so a caller can author
    // `outputRef` itself. Reading whatever key it names is evidence substitution when the bytes are somebody
    // else's, and disclosure when the caller only wanted to see them.
    name: "a forged ref reads another trajectory's object",
    file: "packages/application-control/src/ports/offloading-trajectory-store.ts",
    from: "    if (!ownsPayloadKey(key, tenant, runId))",
    to: "    if (!(void ownsPayloadKey, void tenant, void runId, false))",
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/ports/payload-offload.counterexample.test.ts"],
  },
  {
    // R121. The same forged ref on the deletion side — retention took any `artifact://…` it found in an
    // expiring trajectory as authority to remove that key, which is another run's evidence destroyed.
    name: "retention deletes an object the trajectory does not own",
    file: "packages/application-control/src/ports/offloading-trajectory-store.ts",
    from: "        if (!ownsPayloadKey(key, owned.tenant, owned.runId)) continue;",
    to: "        if (!(void ownsPayloadKey, void owned, true)) continue;",
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/ports/payload-offload.counterexample.test.ts"],
  },
  {
    // R121. A bounded enumeration composed with an unbounded delete: at `limit + 1` distinct refs the last
    // object is named by nothing, because the rows that named it are gone and no later pass can find it.
    name: "the sweep deletes rows after accounting for only one page of refs",
    file: "packages/application-control/src/ports/offloading-trajectory-store.ts",
    from: "      if (refs.length < page) break;",
    to: "      if (refs.length <= page) break;",
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/ports/payload-offload.counterexample.test.ts"],
  },
  {
    // R120. The event row's ref is the ONLY pointer to an offloaded payload, so a retention sweep that
    // deletes rows first leaves bytes nothing can ever name again. Objects first, then the rows — and if the
    // object store refuses, the rows stay so the next sweep can still find what it owes.
    name: "retention deletes the rows and leaves the payload bytes",
    file: "packages/application-control/src/ports/offloading-trajectory-store.ts",
    from: "    const refs = await this.inner.payloadRefsOlderThan(cutoffIso, PAYLOAD_SWEEP_LIMIT);",
    to: "    const refs = (void PAYLOAD_SWEEP_LIMIT, [] as string[]);",
    build: "@everdict/application-control",
    suite: ["--root", "packages/application-control", "src/ports/payload-offload.counterexample.test.ts"],
  },
  {
    // R1. A spans plane is projected from its attributes BY THE STORE, so resolving the record afterwards
    // fixes the spans and leaves the stream every judge reads truncated. Silently. The resolve has to redo
    // the projection from the resolved record.
    name: "OOM — a resolved spans plane keeps the projection made from previews",
    file: "packages/application-control/src/ports/offloading-trajectory-store.ts",
    from: "          events: spansToEvents(spans, result.page.batch !== undefined ? { batch: result.page.batch } : {}),",
    to: "          events: (void spansToEvents, result.page.events),",
    build: "@everdict/application-control",
    suite: ["--root", "packages/db", "src/results/offloaded-spans-projection.counterexample.test.ts"],
  },
  {
    // The windowed read is only delivered if the TRANSPORT passes a window. It shipped with neither of its
    // two transports doing so — the response advertised a `nextAfter` no caller could act on, and the
    // service's own comment claimed the opposite. Covers the HTTP lane, which the counterexample drives; the
    // MCP twin is the same call one file over and BFF↔MCP parity is what keeps them together.
    name: "OOM — the run-trajectory route drops the window it was given",
    file: "apps/api/src/api/run/run.routes.ts",
    from: "        const trajectory = await deps.service.trajectory(principal.workspace, req.params.id, principal.subject, {",
    to: "        void after;\n        void limit;\n        const trajectory = await deps.service.trajectory(principal.workspace, req.params.id, principal.subject);\n        void ({",
    suite: ["--root", "apps/api", "src/api/run/run-trajectory-paging.counterexample.test.ts"],
  },
];

// ── ONE RUNG AT A TIME, FOR RE-AIMING (arch-review 65) ──────────────────────────────────────────────
//
// A rung whose target line a change MOVED fails rather than silently testing nothing, which is the design —
// and re-aiming it then has to be verified, because a rung that matches but does not break is worse than a
// hole (it reads as enforcement). Verifying meant a full run: 174 rungs, each with a package build.
//
// So the whole suite stays the CI contract and `--only <substring>` is the author's loop. It is deliberately
// not a way to run less in CI: `pnpm protocol-mutations` with no argument is every rung, and the summary line
// below says how many ran.
// ⚠️ AN UNKNOWN FLAG RAN THE WHOLE SUITE IN SILENCE (arch-review 111). `--filter <name>` — a plausible spelling
// of the flag below, and not the one this script has — was accepted without comment and the run became a full
// one: ninety minutes instead of one rung, mutating files the author was editing at the time, and an answer to
// a question nobody asked. The tool said nothing, and nothing is not confirmation (rule `ci`, the same shape as
// `biome check --write` exiting 0 over unapplied fixes). Anything not recognised here is now a refusal.
const ARGS = process.argv.slice(2);
const KNOWN_FLAGS = new Set(["--only", "--shard"]);
for (let i = 0; i < ARGS.length; i++) {
  const arg = ARGS[i];
  if (!arg.startsWith("--")) continue; // a flag's value
  if (!KNOWN_FLAGS.has(arg)) {
    console.error(`✖ unknown option ${JSON.stringify(arg)}. This script takes only: ${[...KNOWN_FLAGS].join(", ")}.`);
    console.error("  Refusing rather than running the full suite under a flag you did not mean to omit.");
    process.exit(2);
  }
  i++; // skip the value belonging to this flag
}
// ⚠️ `.git` IS A FILE IN A WORKTREE (arch-review 116). Hardcoding `${cwd}/.git/…` writes fine in the primary
// checkout and fails ENOTDIR in every `git worktree` — which is exactly where this gate deserves to run, since
// a throwaway worktree built from HEAD alone is the only way to see what a fresh checkout compiles to.
// `--absolute-git-dir` is what `ci-commits.mjs` already uses for the same reason.
const STALE_MARK = `${execFileSync("git", ["rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim()}/everdict-mutation-stale-dist`;

// ── A BUILD THAT FAILED IS NOT A BUILD (arch-review 115) ────────────────────────────────────────────
//
// `spawnSync` returns an outcome and the first version of this discarded it at all five call sites. That is
// `Promise<void>` in shell form, and it corrupts the ONE thing this gate produces: if a restore-build fails,
// the marker is cleared anyway, the next rung's suite loads the previous rung's mutated `dist`, it goes red,
// and the runner records that rung's protocol as ENFORCED. A pre-test build that fails does the same — vitest
// exits nonzero because nothing compiled, and nonzero is the only thing this loop reads.
//
//     the test process was red   ≠   the protocol assertion made it red
//
// So every build is consumed, and a failure is an INFRASTRUCTURE failure that stops the run — never a
// mutation result. This gate is a required CI step; a certificate it cannot justify is worse than no gate.
// ⚠️ AND THE TARGET HAS TO EXIST. `pnpm -F @everdict/typo build` matches no package and exits **0** — so a
// renamed package would leave every rung that names the old one running its suite against a dist nobody
// rebuilt, while `rebuildOrThrow` accepted the silence as success. Same class as the failure above, one level
// down, and it cannot be seen from the exit code, so the names are checked once against the real workspace.
const WORKSPACE_PACKAGES = new Set(
  execFileSync("bash", ["-c", "cat packages/*/package.json apps/*/package.json 2>/dev/null"], { encoding: "utf8" })
    .split("\n")
    .map((line) => /^\s*"name":\s*"([^"]+)"/.exec(line)?.[1])
    .filter((name) => name !== undefined),
);
const unknownTargets = [...new Set(MUTATIONS.map((m) => m.build).filter(Boolean))].filter(
  (target) => !WORKSPACE_PACKAGES.has(target),
);
if (unknownTargets.length > 0) {
  console.error(`✖ ${unknownTargets.length} rung(s) name a build target no workspace package has:`);
  for (const target of unknownTargets) console.error(`  ${target}`);
  console.error("  `pnpm -F <unmatched> build` exits 0, so these would run their suites against a stale dist.");
  process.exit(2);
}

function rebuildOrThrow(target) {
  const result = spawnSync("pnpm", ["-F", target, "build"], { stdio: "ignore" });
  if (result.error !== undefined || result.signal !== null || result.status !== 0) {
    throw new Error(
      `rebuilding ${target} failed (${result.error?.message ?? `signal ${result.signal ?? "-"} / status ${result.status ?? "-"}`}).
  This is a GATE FAILURE, not a mutation result: every suite after this point would load a stale dist.
  The stale-dist marker is kept, so the next run rebuilds before it does anything else.`,
    );
  }
}

// ── THE DEFERRED REBUILD IS OWED BY A PACKAGE, NOT BY AN ARRAY INDEX (arch-review 115) ──────────────
//
// The first version decided the group boundary from `ORDERED[index + 1]?.build` — the next DECLARED rung.
// A rung that SKIPS for missing infrastructure, or whose target line is gone, `continue`s from above the
// `try`, so it never reaches the `finally` that would settle the debt, and it is not a boundary either. Five
// rungs skip in the core CI job today, and a simulation over the real ordering put every one of them
// directly after a deferred build: `@everdict/application-control`, `@everdict/db` ×3, `@everdict/storage`.
// So the run that reported "231 checked, 0 holes" did so with a mutated dist standing at five boundaries.
//
// The debt belongs to the PACKAGE whose dist is dirty. It is settled before the next rung that builds
// something else — runnable or not — and after the loop, whatever the exit path.
let pendingRestore;
function settlePending(nextTarget) {
  if (pendingRestore === undefined || pendingRestore === nextTarget) return;
  rebuildOrThrow(pendingRestore); // throws → the marker below is NOT cleared → the next run heals first
  pendingRestore = undefined;
  rmSync(STALE_MARK, { force: true });
}

if (existsSync(STALE_MARK)) {
  const stale = readFileSync(STALE_MARK, "utf8").split("\n").filter(Boolean);
  console.log(`↻ healing ${stale.length} package(s) whose dist a killed run left mutated: ${stale.join(", ")}`);
  // A heal that fails keeps the marker and stops the run: mutating on top of somebody else's stale dist is
  // exactly the state this marker exists to prevent. A marker naming a package that no longer EXISTS is the
  // same hazard wearing the pnpm-exits-0 disguise — the dist is still dirty and nothing would rebuild it.
  const unknownStale = stale.filter((target) => !WORKSPACE_PACKAGES.has(target));
  if (unknownStale.length > 0) {
    console.error(`✖ the stale-dist marker names ${unknownStale.join(", ")}, which no workspace package has.`);
    console.error("  That dist cannot be rebuilt by name, so nothing here may run. Rebuild by hand and remove");
    console.error(`  ${STALE_MARK}.`);
    process.exit(2);
  }
  for (const target of stale) rebuildOrThrow(target);
  rmSync(STALE_MARK, { force: true });
}

const only = ARGS.includes("--only") ? ARGS[ARGS.indexOf("--only") + 1] : undefined;
if (ARGS.includes("--only") && (only === undefined || only.startsWith("--"))) {
  console.error("✖ --only needs a substring of a mutation's name.");
  process.exit(2);
}
const SELECTED = only === undefined ? MUTATIONS : MUTATIONS.filter((m) => m.name.includes(only));
if (only !== undefined && SELECTED.length === 0) {
  console.error(`✖ no protocol mutation's name contains ${JSON.stringify(only)} — nothing would have run.`);
  process.exit(2);
}

// ── SHARDING, BECAUSE ONE JOB CANNOT HOLD THIS GATE (arch-review 120) ───────────────────────────────
//
// The full gate is ~90 minutes of real builds and real suites, and it was a STEP inside a job declared
// `timeout-minutes: 30`. That job could never have reached the end of it — and everything after the step
// (docs-check, constructed-casts, guarded-doubles, the rest) could never have run at all. The gate is
// required, so a required check that cannot finish is a check nobody has ever seen pass.
//
// Shards are whole BUILD GROUPS, distributed longest-first onto the least-loaded shard. Splitting inside a
// group would make each shard rebuild the same package, which is exactly the waste the grouping above
// removed; splitting between groups preserves it — every shard still compiles each package once per group
// and settles its own deferred rebuild at its own end.
//
// ⚠️ A GREEN SHARD IS NOT A GREEN GATE. Same discipline as `--only`: the summary says SHARD and says how
// many of the whole it covered, so a log skimmed for the tick cannot be mistaken for full coverage. CI runs
// every shard and a job that requires all of them.
const shardArg = ARGS.includes("--shard") ? ARGS[ARGS.indexOf("--shard") + 1] : undefined;
if (ARGS.includes("--shard") && (shardArg === undefined || shardArg.startsWith("--"))) {
  console.error("✖ --shard needs <index>/<total>, 1-based (e.g. --shard 2/4).");
  process.exit(2);
}
let SHARDED = SELECTED;
let shardLabel;
if (shardArg !== undefined) {
  const match = /^(\d+)\/(\d+)$/.exec(shardArg);
  if (match === null) {
    console.error(`✖ --shard ${JSON.stringify(shardArg)} is not <index>/<total>, 1-based (e.g. --shard 2/4).`);
    process.exit(2);
  }
  const index = Number(match[1]);
  const total = Number(match[2]);
  if (total < 1 || index < 1 || index > total) {
    console.error(`✖ --shard ${shardArg}: index must be between 1 and total, and total at least 1.`);
    process.exit(2);
  }
  // A rung with NO build target has no compile to amortize, so it is its own group and may land anywhere;
  // only the build groups have to stay whole. Keeping the 126 build-free rungs bundled made a 4-way split
  // [126, 74, 26, 26] — one shard doing half the gate for no reason.
  const buildGroups = [...new Set(SELECTED.map((m) => m.build).filter((b) => b !== undefined))].map((target) =>
    SELECTED.filter((m) => m.build === target),
  );
  const groups = [...buildGroups, ...SELECTED.filter((m) => m.build === undefined).map((m) => [m])].sort(
    (a, b) => b.length - a.length,
  );
  const bins = Array.from({ length: total }, () => []);
  for (const group of groups) {
    let lightest = 0;
    for (let i = 1; i < bins.length; i++) if ((bins[i]?.length ?? 0) < (bins[lightest]?.length ?? 0)) lightest = i;
    bins[lightest]?.push(...group);
  }
  SHARDED = bins[index - 1] ?? [];
  shardLabel = `${index}/${total}`;
  // An empty shard is not a pass. More shards than build groups is a configuration error, and answering
  // "0 checked, all green" to it is the vacuous certificate this gate exists to refuse.
  if (SHARDED.length === 0) {
    console.error(`✖ shard ${shardLabel} holds no rungs — there are only ${groups.length} build groups to spread.`);
    console.error("  Lower the shard count; an empty shard reports success for work nobody did.");
    process.exit(2);
  }
}

// Every rung's file, not only the selected ones: a partial run still writes into the tree, and the same
// "restore the exact original" promise has to hold for the file it touches.
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

// ── ONE BUILD PER PACKAGE BOUNDARY, NOT TWO PER RUNG ───────────────────────────────────────────────
//
// Each rung used to run mutate → build → test → restore → build, and 113 of the 236 declare a `build`. That
// is 226 full package compiles, and `@everdict/application-control` alone — 63 rungs — costs ~9.8s each, so
// well over half the gate's wall clock was spent rebuilding a package the NEXT rung was about to rebuild
// anyway. The restore-build is thrown away every time except at the boundary where the target changes.
//
// So the rungs are GROUPED by build target (stable within a group, so a group still reads in the order it was
// written), and the restore-build runs only when the next rung builds something else. Nothing about what is
// checked changes: within a group, every rung still compiles the package from its own mutated source before
// its suite runs, because the rung's own pre-test build does that.
//
// The boundary rebuild is not optional. A rung with no `build` — or one in a different package — may load
// this package's `dist`, and a stale one would run the PREVIOUS rung's mutation against a suite that never
// asked for it. That is the stale-dist trap this repository has already paid for once (arch-review 76-92),
// which is why the condition is "the next rung builds the same thing", never "the next rung has a build".
const BUILD_ORDER = [...new Set(SHARDED.map((m) => m.build ?? ""))];
const ORDERED = BUILD_ORDER.flatMap((target) => SHARDED.filter((m) => (m.build ?? "") === target));

// ⚠️ AND THE KILL PATH. `finally` restores the SOURCE but does not run on SIGKILL, and now a normal-looking
// tree can hide a `dist` carrying the last mutation. `dist/` is gitignored, so unlike the old failure mode it
// cannot be committed — but it can silently poison a test run in this shared tree. So a package whose
// restore-build is deferred is recorded here first, and the next run compiles it before doing anything else.
// SIGKILL cannot be caught — that is what the marker above is for — but an ordinary interrupt can put the
// tree right instead of leaving the next run to.
let interrupted;
// ⚠️ THIS HANDLER CALLED A FUNCTION THAT NO LONGER EXISTED (arch-review 120). `rebuild` was renamed to
// `rebuildOrThrow` when builds started being CONSUMED (arch-review 115), and the two call sites in here were
// not renamed with it. Nothing caught that: this is a `.mjs`, so no compiler reads it, `node --check` proves
// only that it PARSES, and a handler that never runs in a green run is dead code until the day it matters.
//
// What it produced is the exact state the marker exists to prevent: SIGTERM → source restored → ReferenceError
// → handler aborts before the rebuild and before the marker is written → a CLEAN source over a MUTATED dist,
// with nothing recording the debt. Observed in this repository, and read as "the handler is still rebuilding".
//
// So the order is now: record the debt BEFORE paying it, pay every target, and clear the marker only when
// every rebuild has succeeded. A handler that throws half-way leaves the marker, which is the next run's
// instruction; a handler that clears first leaves nothing at all.
const heal = () => {
  const owed = new Set(existsSync(STALE_MARK) ? readFileSync(STALE_MARK, "utf8").split("\n").filter(Boolean) : []);
  if (interrupted?.build) owed.add(interrupted.build);
  // The debt is durable BEFORE any rebuild runs — a rebuild that throws must not take the record with it.
  if (owed.size > 0) writeFileSync(STALE_MARK, [...owed].join("\n"));
  // The rung in flight, if there is one: its source goes back first, so whatever is rebuilt is HEAD's code.
  if (interrupted !== undefined) writeFileSync(interrupted.file, interrupted.original);
  for (const target of owed) rebuildOrThrow(target);
  // Every target compiled from restored source — only now is there nothing left to tell the next run.
  rmSync(STALE_MARK, { force: true });
};
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    heal();
    process.exit(130);
  });
}

// ── AND THE TREE MUST COMPILE BEFORE ANY OF THIS MEANS ANYTHING (arch-review 115) ──────────────────
//
// A rung declaring `compilerEnforced` says "removing this protocol is a type error". That reading is only
// available if the tree compiled BEFORE the mutation — otherwise an unrelated break (a port that grew a
// method its test doubles have not learned, say) reports every rung in that package as either a compiler
// catch or a hole, and both are lies about the protocol. Seen exactly that way: a port change of mine put
// 13 rungs into "does not compile" in one run.
//
// So the baseline is established once, and a tree that does not build stops the gate here — where the
// message is about the tree, not about somebody's protocol.
for (const target of [...new Set(SELECTED.map((m) => m.build).filter(Boolean))]) {
  const baseline = spawnSync("pnpm", ["-F", target, "build"], { stdio: "ignore" });
  if (baseline.status !== 0 || baseline.error !== undefined || baseline.signal !== null) {
    console.error(`✖ ${target} does not build BEFORE any mutation — fix the tree first.`);
    console.error("  Every rung in that package would otherwise report a compile failure as its own result.");
    process.exit(2);
  }
}

// ── A PROCESS THAT EXITED NONZERO IS NOT AN ASSERTION THAT FAILED (arch-review 120) ────────────────
//
// The whole output of this gate is the claim "the suite went red BECAUSE the protocol was removed", and the
// evidence for it was `vitest exit !== 0`. Everything else that exits nonzero was therefore counted as
// enforcement: a suite path that moved, a config error, a collection failure, an unhandled setup throw, an
// `npx` that could not spawn, a signal. "No test files found" exits nonzero and reads as a protocol caught.
//
// arch-review 115 already made the BUILD half of this honest. This is the run half: the outcome is a union,
// and only `assertion_red` is enforcement. Read from vitest's own JSON reporter rather than from the exit
// code, because the exit code is the one thing every failure mode agrees on.
function runOutcome(suite, env) {
  const run = spawnSync("npx", ["vitest", "run", "--reporter=json", ...suite], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if (run.error !== undefined)
    return { kind: "infrastructure_failed", why: `vitest could not be spawned: ${run.error.message}` };
  if (run.signal !== null) return { kind: "signalled", why: `vitest was killed by ${run.signal}` };
  // The reporter prints one JSON document; anything vitest wrote before it (a config throw, a resolver error)
  // sits in front of it, so the parse starts at the first brace rather than at byte zero.
  const raw = run.stdout ?? "";
  const at = raw.indexOf("{");
  let report;
  if (at !== -1) {
    try {
      report = JSON.parse(raw.slice(at));
    } catch {
      report = undefined;
    }
  }
  if (report === undefined)
    return {
      kind: "infrastructure_failed",
      why: "vitest produced no JSON report — it did not get as far as running tests",
    };
  const total = report.numTotalTests ?? 0;
  const failed = report.numFailedTests ?? 0;
  const suitesFailed = report.numFailedTestSuites ?? 0;
  // A suite that collected NOTHING has not answered the question — the commonest way for this to happen is a
  // path that moved, which the old check read as the protocol being enforced.
  if (total === 0) return { kind: "collection_failed", why: "the suite collected no tests" };
  if (failed > 0) return { kind: "assertion_red", why: `${failed} assertion(s) failed` };
  // Files that failed to LOAD are reported as failed suites with no failed tests: still not an assertion.
  if (suitesFailed > 0) return { kind: "collection_failed", why: `${suitesFailed} suite(s) failed to load` };
  return { kind: "green", why: "every test passed with the protocol removed" };
}

let holes = 0;
// Runs that could not ANSWER — a moved suite, a config throw, a signal. Never enforcement, never a hole.
let unusable = 0;
let skipped = 0;
let compilerCaught = 0;
for (const mutation of ORDERED) {
  // ── A RUNG WHOSE SUITE NEEDS REAL INFRASTRUCTURE (arch-review 66) ───────────────────────────────
  //
  // Some protocols live in the ADAPTER — a SQL join, a constraint, a conditional UPDATE's WHERE clause — and
  // their counterexample is a `*.trust.test.ts` against real Postgres. Running one without a database does
  // not fail: vitest SKIPS the describe and exits 0, which this runner would read as "the suite stayed green
  // with the protocol removed" — a HOLE reported for a rung that never ran.
  //
  // So the prerequisite is declared and a rung without it is SKIPPED LOUDLY and counted in the summary. That
  // is not the same as covered, and the summary says so rather than letting the total imply it. The required
  // `trust fast (real Postgres)` check runs the scenario itself on every push; what is deferred here is the
  // neutralization, not the assertion.
  // BEFORE anything this rung does, including deciding not to run: a rung that skips or has no target still
  // moves the run past the package whose dist is dirty, and the suite after it must not load that dist.
  settlePending(mutation.build);
  const missing = (mutation.requiresEnv ?? []).filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.log(`○ SKIPPED — ${mutation.name}: needs ${missing.join(", ")}`);
    skipped += 1;
    continue;
  }
  const original = readFileSync(mutation.file, "utf8");
  if (!original.includes(mutation.from)) {
    console.error(`✖ ${mutation.name}: the line to mutate is gone from ${mutation.file}`);
    console.error("  A mutation that matches nothing tests nothing — update it to the code as it is now.");
    holes += 1;
    continue;
  }
  try {
    interrupted = { file: mutation.file, original, build: mutation.build };
    writeFileSync(mutation.file, original.replace(mutation.from, mutation.to));
    // ── A MUTATED TREE THAT DOES NOT COMPILE IS A THIRD OUTCOME (arch-review 115) ──────────────
    //
    // A cross-package rung's suite imports this package from `dist` (`exports` points there; no vitest
    // alias to src), so the build is load-bearing — and some neutralizations cannot compile at all.
    // `if (false && worksRead.kind === "unknown")` defeats the narrowing the block below relies on, which
    // is the type system REFUSING to let that guard be removed: enforcement, and stronger than a red suite.
    //
    // Ignoring the failure — as this did before — runs the suite against whatever `dist` still holds. In
    // the optimized ordering that is the PREVIOUS rung's mutation, so the suite goes red for somebody
    // else's reason and this rung is recorded as enforced. That false certificate is not hypothetical: it
    // is what the 28-minute run reporting "231 checked, 0 holes" produced for this very rung.
    //
    // So the outcome is named, and a rung must DECLARE that its neutralization is type-enforced. Undeclared
    // and uncompilable is a HOLE: a replacement nobody can build tests no suite, and the author has to say
    // which of the two it is.
    if (mutation.build) {
      const built = spawnSync("pnpm", ["-F", mutation.build, "build"], { stdio: "ignore" });
      if (built.status !== 0 || built.error !== undefined || built.signal !== null) {
        if (mutation.compilerEnforced === true) {
          console.log(`✓ ${mutation.name} — the mutated tree does not COMPILE, as it must`);
          compilerCaught += 1;
        } else {
          console.error(`✖ ${mutation.name}: the mutated tree does not compile, so its suite never ran.`);
          console.error("  Rewrite the replacement so it builds, or declare `compilerEnforced: true` if the");
          console.error("  type system is what refuses to let this protocol be removed.");
          holes += 1;
        }
        continue; // the `finally` still restores the source and records the dist debt
      }
    }
    const outcome = runOutcome(mutation.suite, mutation.env ?? {});
    if (outcome.kind === "assertion_red") {
      console.log(`✓ ${mutation.name} — the suite went red, as it must (${outcome.why})`);
    } else if (outcome.kind === "green") {
      console.error(`✖ HOLE — ${mutation.name}: the suite stayed GREEN with the protocol removed.`);
      holes += 1;
    } else {
      // Not a verdict about the protocol at all. Counting it as one is how a moved suite path certified a
      // protocol nobody tested, so it is a GATE failure with its own name.
      console.error(`✖ UNUSABLE — ${mutation.name}: ${outcome.why} (${outcome.kind}).`);
      console.error("  This says nothing about the protocol. Fix the suite reference or the environment;");
      console.error("  a run that could not answer must never be recorded as one that did.");
      unusable += 1;
    }
  } finally {
    writeFileSync(mutation.file, original);
    interrupted = undefined;
    // The source is back; the DIST still holds this rung's mutation. Record the debt unconditionally and let
    // `settlePending` decide when to pay it — deriving the boundary here from the next declared rung is what
    // let a skip swallow it (arch-review 115).
    if (mutation.build) {
      pendingRestore = mutation.build;
      writeFileSync(STALE_MARK, mutation.build);
    }
  }
}

// Whatever the exit path, the last group's dist goes back. `settlePending(undefined)` is the same transition
// the loop makes — there is simply no next rung to compare against.
settlePending(undefined);

if (holes > 0) {
  console.error(`\n✖ ${holes} protocol(s) are not actually enforced by the suite that claims to enforce them.`);
  process.exit(1);
}
if (unusable > 0) {
  // A separate exit from a HOLE on purpose: a hole says the protocol is untested, this says the gate could
  // not find out. Both are red, and conflating them is what let the second wear the first's certificate.
  console.error(`\n✖ ${unusable} rung(s) produced no verdict at all — the gate could not answer for them.`);
  process.exit(1);
}
console.log(
  `\n✓ every protocol mutation was caught by an ASSERTION (${ORDERED.length - skipped} checked${
    compilerCaught > 0 ? `, ${compilerCaught} of them by the COMPILER rather than by a suite` : ""
  }${
    skipped > 0 ? `, ${skipped} SKIPPED for missing infrastructure — not the same as covered` : ""
  }${only === undefined ? "" : ` of ${MUTATIONS.length} — SUBSET, \`--only ${only}\``}${
    shardLabel === undefined ? "" : ` of ${MUTATIONS.length} — SHARD ${shardLabel}, NOT the whole gate`
  })`,
);
