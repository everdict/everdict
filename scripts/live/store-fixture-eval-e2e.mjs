// Live E2E: a realistic data-as-condition EVAL, end-to-end through the real code (P2).
//
// The scenario (a usage example): a harness has a purpose:"data" postgres store. The dataset case carries a FIXTURE
// (two orders, both 'pending') and the task "ship the pending orders". The verdict is the DB's FINAL state, checked by
// the StoreStateGrader. We run it for a GOOD agent (ships them) and a BAD agent (does nothing) and show the grader
// DISCRIMINATES — pass vs fail — i.e. the feature is actually experimentable.
//
// What is real: a postgres:16-alpine on the user's Docker; the REAL DockerTopologyRuntime.seedFixtures /
// readStoreState; the REAL planStoreSeed; the REAL scoreObservations + StoreStateGrader producing the verdict. The
// only stand-in is the "agent" — a psql UPDATE (good) or a no-op (bad) — representing the agent-under-test's effect.
//
// Prereqs: Docker daemon + `pnpm -F @everdict/topology -F @everdict/graders -F @everdict/application-execution build`.
// Usage: node scripts/live/store-fixture-eval-e2e.mjs

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { scoreObservations } from "../../packages/application-execution/dist/index.js";
import { StoreStateGrader } from "../../packages/graders/dist/index.js";
import { DockerTopologyRuntime, isolationSliceKey, planStoreSeed } from "../../packages/topology/dist/index.js";

const docker = (args) => promisify(execFile)("docker", args).catch(() => {});

const SPEC = {
  kind: "service",
  id: "orders-eval",
  version: "1.0.0",
  services: [], // no agent service needed — we drive the "agent effect" directly to keep the demo self-contained
  dependencies: [{ store: "postgres", role: "world", purpose: "data", isolateBy: "schema" }],
  frontDoor: { service: "x", submit: "POST /runs" },
  traceSource: { kind: "mlflow", endpoint: "http://unused" },
};

const runtime = new DockerTopologyRuntime();

const EVAL_CASE = {
  id: "ship-orders",
  env: { kind: "prompt" },
  task: "ship the pending orders",
  graders: [],
  timeoutSec: 60,
  tags: [],
};
const GRADER = new StoreStateGrader({
  store: "postgres",
  role: "world",
  query: "SELECT status FROM orders ORDER BY id",
  expect: "shipped\nshipped", // both orders must end up shipped
  mode: "exact",
});

async function runScenario(runId, agentShips) {
  // GIVEN — the dataset fixture: two pending orders. The REAL planStoreSeed binds/validates it, seedFixtures applies it.
  const fixture = {
    store: "postgres",
    role: "world",
    seed: {
      inline:
        "DROP TABLE IF EXISTS orders; CREATE TABLE orders(id int, status text); INSERT INTO orders VALUES (1,'pending'),(2,'pending');",
    },
  };
  await runtime.seedFixtures(SPEC, runId, planStoreSeed([fixture], SPEC.dependencies, runId));

  // WHEN — the agent-under-test operates on its data store (stand-in for the real agent's effect).
  if (agentShips) {
    const slice = isolationSliceKey("schema", runId);
    await runtime.seedFixtures(SPEC, runId, [
      {
        store: "postgres",
        role: "world",
        isolateBy: "schema",
        slice,
        seed: { inline: "UPDATE orders SET status='shipped'" },
        format: "sql",
      },
    ]);
  }

  // THEN — grade on the POST-RUN store state via the REAL scoring path (scoreObservations + StoreStateGrader + readStore).
  const scores = await scoreObservations({
    evalCase: EVAL_CASE,
    trace: [],
    snapshot: { kind: "prompt", output: "" },
    graders: [GRADER],
    readStore: (q) => runtime.readStoreState(SPEC, runId, q),
  });
  return scores.find((s) => s.graderId === "store-state");
}

async function main() {
  // Fresh store each run (the runtime warm-adopts a same-name container otherwise → leftover slices).
  await docker(["rm", "-f", "everdict-orders-eval-1.0.0-orders-eval-postgres"]);
  await docker(["network", "rm", "everdict-orders-eval-1.0.0"]);
  console.log("→ ensuring the topology (real postgres data store)…");
  await runtime.ensureTopology(SPEC);

  console.log("→ scenario A — GOOD agent (ships the orders):");
  const good = await runScenario("good", true);
  console.log(`   store-state verdict: pass=${good?.pass}  detail=${JSON.stringify(good?.detail)}`);

  console.log("→ scenario B — BAD agent (does nothing):");
  const bad = await runScenario("bad", false);
  console.log(`   store-state verdict: pass=${bad?.pass}  detail=${JSON.stringify(bad?.detail)}`);

  if (good?.pass !== true) throw new Error("GOOD agent should PASS but did not");
  if (bad?.pass !== false) throw new Error("BAD agent should FAIL but did not");
  console.log("\n✅ PASS — the eval discriminates: GOOD agent passes, BAD agent fails, verdict computed from the real");
  console.log("   post-run DB state. Data-as-condition works end-to-end and is experimentable.");
}

main()
  .catch((e) => {
    console.error("\n❌ FAIL:", e.message);
    process.exitCode = 1;
  })
  .finally(() => runtime.teardown?.().catch(() => {}));
