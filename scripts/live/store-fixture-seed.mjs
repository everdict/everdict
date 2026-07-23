// Live verification: fixture seed + store-state read against a REAL postgres (P2, data-as-condition).
//
// What is "real":
//  - a postgres:16-alpine container on the user's Docker (the same image the topology runtimes deploy)
//  - the seed exec (buildSeedExec) runs real `psql` INTO the case's schema slice — proving the pure builder against psql
//  - the store-state read (buildReadExec) runs real `psql` and returns stdout — the co-located read the grader relies on
//
// This exercises the runtime-agnostic core of P2 (buildSeedExec/buildReadExec) end-to-end against a real store, without
// standing up a full agent topology. The Docker/K8s/Nomad runtimes wrap exactly this exec around their container reach.
//
// Prereqs: a running Docker daemon + `pnpm -F @everdict/topology build` (scripts import the built dist).
// Usage: node scripts/live/store-fixture-seed.mjs

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildReadExec, buildSeedExec } from "../../packages/topology/dist/index.js";

const sh = promisify(execFile);
const docker = (args) => sh("docker", args).then((r) => r.stdout);

const NET = "everdict-live-seed-net";
const PG = "everdict-live-seed-pg";
const SLICE = "run_live"; // the per-case schema slice (isolationSliceKey for isolateBy:"schema")

async function cleanup() {
  await docker(["rm", "-f", PG]).catch(() => {});
  await docker(["network", "rm", NET]).catch(() => {});
}

async function waitAccepting() {
  for (let i = 0; i < 60; i++) {
    try {
      await docker(["exec", PG, "pg_isready", "-U", "everdict"]);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("postgres did not become ready");
}

async function main() {
  await cleanup();
  console.log("→ deploying a real postgres…");
  await docker(["network", "create", NET]);
  await docker([
    "run",
    "-d",
    "--name",
    PG,
    "--network",
    NET,
    "-e",
    "POSTGRES_USER=everdict",
    "-e",
    "POSTGRES_PASSWORD=everdict",
    "-e",
    "POSTGRES_DB=everdict",
    "postgres:16-alpine",
  ]);
  await waitAccepting();

  // 1) SEED — the fixture the DATASET would carry, into the case's schema slice.
  const plan = {
    store: "postgres",
    role: "world",
    isolateBy: "schema",
    slice: SLICE,
    seed: {
      inline: "CREATE TABLE orders(id int, status text); INSERT INTO orders VALUES (1,'shipped'),(2,'pending');",
    },
    format: "sql",
  };
  console.log("→ seeding the fixture (buildSeedExec → real psql)…");
  for (const argv of buildSeedExec(plan).argvs) await docker(["exec", PG, ...argv]);

  // 2) READ — the store-state grader's post-run read of the same slice.
  console.log("→ reading the post-run state (buildReadExec → real psql)…");
  const out = (
    await docker(["exec", PG, ...buildReadExec("postgres", SLICE, "SELECT status FROM orders ORDER BY id")])
  ).trim();

  console.log(`   read back:\n${out.replace(/^/gm, "     ")}`);
  const expected = "shipped\npending";
  if (out !== expected) throw new Error(`MISMATCH — expected \n${expected}\n got \n${out}`);
  console.log(
    "\n✅ PASS — seed landed in the case slice and read back verbatim (seed → operate → judge core is real).",
  );
}

main()
  .catch((e) => {
    console.error("\n❌ FAIL:", e.message);
    process.exitCode = 1;
  })
  .finally(cleanup);
