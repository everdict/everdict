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
    to: "  if (false && !onReserved)",
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
    from: '    if (unresolved !== undefined) return { kind: "unknown", reason: unresolved };',
    to: '    if (false && unresolved !== undefined) return { kind: "unknown", reason: "" };',
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
    name: "Wave C — the publication claim moves back below the effects",
    file: "packages/application-control/src/scorecard/publication.ts",
    from: "  const claimed = await deps.operations.claim(operation.id, owner, leaseSeconds, now());",
    to: "  const outcomeFirst = await performEffects(deps, record, operation, results);\n  void outcomeFirst;\n  const claimed = await deps.operations.claim(operation.id, owner, leaseSeconds, now());",
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
    from: '    if (pin !== undefined && provenance?.kind !== "recorded" && policy.allowUnrecordedJudgments !== true)',
    to: '    if (false && pin !== undefined && provenance?.kind !== "recorded" && policy.allowUnrecordedJudgments !== true)',
    suite: ["--root", "packages/domain", "src/scorecard/judgment-provenance.counterexample.test.ts"],
  },
  {
    name: "Wave E — every teardown failure records as merely requested",
    file: "packages/application-control/src/cancellation/cancellation-coordinator.ts",
    from: '    const reached: "requested" | "verifying" = detail?.unverifiable !== undefined ? "verifying" : "requested";',
    to: '    const reached: "requested" | "verifying" = "requested";',
    suite: ["--root", "packages/application-control", "src/cancellation/verified-completion.counterexample.test.ts"],
  },
];

const files = [...new Set(MUTATIONS.map((m) => m.file))];
const dirty = execFileSync("git", ["status", "--porcelain", "--", ...files], { encoding: "utf8" }).trim();
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
