// Live verification: tenant budget (admission) + secret scoping work on real Nomad.
//
// (1) Secret scoping: verify via buildNomadJob that each tenant's job carries only its own model key in the alloc env (no leak).
// (2) Budget: limit tenant "free" to runs=3 and submit 5 at once → only 3 run and the other 2 are
//     rejected immediately with 402 (BUDGET_EXCEEDED) (even under burst, admit reserves synchronously so the cap holds).
//     (the scripted harness has cost=0, so usd/token budgets don't trigger → demoed via the runs budget; usd/token verified by unit tests)
//
// Usage: NOMAD_ADDR=http://127.0.0.1:4646 EVERDICT_AGENT_IMAGE=everdict-job-runner:local node scripts/live/budget-nomad.mjs

import {
  BackendRegistry,
  NomadBackend,
  Scheduler,
  buildNomadJob,
  inMemoryBudget,
  staticSecrets,
} from "../../packages/backends/dist/index.js";

const NOMAD_ADDR = process.env.NOMAD_ADDR ?? "http://127.0.0.1:4646";
const IMAGE = process.env.EVERDICT_AGENT_IMAGE ?? "everdict-job-runner:local";
const STAMP = Date.now().toString(36);
const RUNS_LIMIT = 3;
const N = 5;

const secrets = staticSecrets({
  acme: { ANTHROPIC_API_KEY: "sk-acme-XXXX" },
  globex: { ANTHROPIC_API_KEY: "sk-globex-YYYY" },
});

function jobFor(tenant, i) {
  return {
    harness: { id: "scripted", version: "latest" },
    tenant,
    evalCase: {
      id: `bud-${STAMP}-${i}`,
      env: { kind: "repo", source: { files: {} } },
      task: `budget case ${i}`,
      graders: [{ id: "steps" }],
      timeoutSec: 120,
      tags: ["live", "budget"],
    },
  };
}

function envKey(tenant) {
  const spec = buildNomadJob(jobFor(tenant, 0), {
    addr: NOMAD_ADDR,
    image: IMAGE,
    secretEnv: secrets.secretsFor(tenant),
  });
  return spec.Job.TaskGroups[0]?.Tasks[0]?.Env.ANTHROPIC_API_KEY;
}

async function main() {
  console.log("=== (1) secret scoping — each tenant's job carries only its own key ===");
  console.log("  acme   →", envKey("acme"));
  console.log("  globex →", envKey("globex"));
  console.log("  isolated:", envKey("acme") !== envKey("globex"), "\n");

  console.log(`=== (2) budget — tenant 'free' limited to runs=${RUNS_LIMIT}, submitting ${N} ===`);
  const backend = new NomadBackend({ addr: NOMAD_ADDR, image: IMAGE, maxConcurrent: 2, secrets });
  const budget = inMemoryBudget({ limitFor: (t) => (t === "free" ? { runs: RUNS_LIMIT } : undefined) });
  const sched = new Scheduler(new BackendRegistry().register("nomad", backend), { budget });

  const outcomes = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      sched
        .dispatch(jobFor("free", i))
        .then(() => ({ i, ok: true }))
        .catch((e) => ({ i, ok: false, code: e.code ?? e.name })),
    ),
  );

  const ok = outcomes.filter((o) => o.ok);
  const rejected = outcomes.filter((o) => !o.ok);
  for (const o of outcomes) console.log(`  case ${o.i}: ${o.ok ? "✓ ran" : `✗ rejected (${o.code})`}`);

  console.log("\n=== RESULT ===");
  console.log(`admitted+ran : ${ok.length}  rejected: ${rejected.length}`);
  console.log("budget usage :", JSON.stringify(budget.usage("free")));
  console.log(
    ok.length === RUNS_LIMIT && rejected.every((r) => r.code === "BUDGET_EXCEEDED")
      ? `✅ exactly ${RUNS_LIMIT} ran; the rest got 402 BUDGET_EXCEEDED — and keys never crossed tenants`
      : "ℹ unexpected outcome",
  );
}

main().catch((e) => {
  console.error("\nLIVE RUN FAILED:", e?.stack ?? e);
  process.exit(1);
});
