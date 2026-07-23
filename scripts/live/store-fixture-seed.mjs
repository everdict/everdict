// Live verification: fixture seed + store-state read against REAL stores (P2, data-as-condition).
//
// What is "real": a postgres:16-alpine and a minio container on the user's Docker (the same images the topology
// runtimes deploy). The seed exec (buildSeedExec) and the store-state read (buildReadExec) run real psql / mc INTO and
// FROM the case's per-case slice — proving the pure builders against real stores, without a full agent topology.
//
// Prereqs: a running Docker daemon + `pnpm -F @everdict/topology build` (scripts import the built dist).
// Usage: node scripts/live/store-fixture-seed.mjs

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildReadExec, buildSeedExec } from "../../packages/topology/dist/index.js";

const sh = promisify(execFile);
const docker = (args) => sh("docker", args).then((r) => r.stdout);
const NET = "everdict-live-seed-net";

async function up(name, image, env, args = []) {
  await docker(["rm", "-f", name]).catch(() => {});
  await docker(["run", "-d", "--name", name, "--network", NET, ...env.flatMap((e) => ["-e", e]), image, ...args]);
}

async function retry(fn, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("timed out waiting for the store");
}

async function cleanup() {
  await docker(["rm", "-f", "everdict-live-pg", "everdict-live-minio"]).catch(() => {});
  await docker(["network", "rm", NET]).catch(() => {});
}

// ── postgres: seed into the schema slice, read it back ──────────────────────────────────────────────────────────────
async function checkPostgres() {
  const C = "everdict-live-pg";
  const SLICE = "run_live"; // isolationSliceKey for isolateBy:"schema"
  await up(C, "postgres:16-alpine", ["POSTGRES_USER=everdict", "POSTGRES_PASSWORD=everdict", "POSTGRES_DB=everdict"]);
  await retry(() => docker(["exec", C, "pg_isready", "-U", "everdict"]));

  const plan = {
    store: "postgres",
    role: "world",
    isolateBy: "schema",
    slice: SLICE,
    format: "sql",
    seed: {
      inline: "CREATE TABLE orders(id int, status text); INSERT INTO orders VALUES (1,'shipped'),(2,'pending');",
    },
  };
  for (const argv of buildSeedExec(plan).argvs) await docker(["exec", C, ...argv]);
  const out = (
    await docker(["exec", C, ...buildReadExec("postgres", SLICE, "SELECT status FROM orders ORDER BY id")])
  ).trim();
  assertEq("postgres", out, "shipped\npending");
}

// ── minio: seed objects under the object-path slice, read one back ───────────────────────────────────────────────────
async function checkMinio() {
  const C = "everdict-live-minio";
  const SLICE = "runs/live/"; // isolationSliceKey for isolateBy:"object-prefix"
  await up(
    C,
    "quay.io/minio/minio:latest",
    ["MINIO_ROOT_USER=everdict", "MINIO_ROOT_PASSWORD=everdictsecret"],
    ["server", "/data"],
  );
  await retry(() =>
    docker(["exec", C, "mc", "alias", "set", "local", "http://localhost:9000", "everdict", "everdictsecret"]),
  );

  const plan = {
    store: "minio",
    role: "files",
    isolateBy: "object-prefix",
    slice: SLICE,
    format: "objects",
    seed: { inline: "mc mb -p local/data >/dev/null; echo shipped | mc pipe local/data/{prefix}status.txt" },
  };
  for (const argv of buildSeedExec(plan).argvs) await docker(["exec", C, ...argv]);
  const out = (
    await docker(["exec", C, ...buildReadExec("minio", SLICE, "mc cat local/data/{prefix}status.txt")])
  ).trim();
  assertEq("minio", out, "shipped");
}

function assertEq(store, got, expected) {
  console.log(`   ${store} read back: ${JSON.stringify(got)}`);
  if (got !== expected)
    throw new Error(`${store} MISMATCH — expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
}

async function main() {
  await cleanup();
  await docker(["network", "create", NET]);
  console.log("→ postgres: seed → read the schema slice…");
  await checkPostgres();
  console.log("→ minio: seed → read the object-prefix slice…");
  await checkMinio();
  console.log(
    "\n✅ PASS — postgres + minio seed landed in the case slice and read back verbatim (seed → judge core is real).",
  );
}

main()
  .catch((e) => {
    console.error("\n❌ FAIL:", e.message);
    process.exitCode = 1;
  })
  .finally(cleanup);
