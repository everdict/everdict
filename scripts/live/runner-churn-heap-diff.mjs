// Heap-snapshot diff proof — the definitive "no object class accumulates under churn" check that RSS (coarse,
// GC/fragmentation-noisy) can't give. Boots a REAL Postgres-backed control plane with
// --heapsnapshot-signal=SIGUSR2, drives runner pair→run→SIGKILL churn, and compares two POST-GC heap snapshots
// (V8 runs a full GC before each dump, so the snapshot counts only RETAINED objects). A leak shows the live
// node_count climbing round-over-round; a leak-free hub/session/registry keeps it flat.
//
// Usage: node scripts/live/runner-churn-heap-diff.mjs [churnRounds=150]
//   Requires a Postgres reachable via DATABASE_URL (this script starts one in a container if unset).
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const PORT = process.env.CP_PORT ?? "8812";
const BASE = `http://127.0.0.1:${PORT}`;
const H = { "content-type": "application/json", "x-everdict-tenant": "default" };
const ROOT = new URL("../..", import.meta.url).pathname;
const ROUNDS = Number(process.argv[2] ?? 150);
const SNAP_DIR = join(tmpdir(), `everdict-heapdiff-${PORT}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", ...opts });
const post = async (p, b) => {
  const r = await fetch(`${BASE}${p}`, { method: "POST", headers: H, body: JSON.stringify(b) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const get = async (p) => (await fetch(`${BASE}${p}`, { headers: H })).json();
const failures = [];
const check = (ok, label) => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failures.push(label);
};

// Extract the live node_count from a .heapsnapshot without parsing the (huge) whole file — it sits in the
// snapshot.meta header near the top. Read the first chunk and regex it.
const readNodeCount = async (file) => {
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(4096);
    await fh.read(buf, 0, 4096, 0);
    const m = buf.toString("utf8").match(/"node_count":(\d+)/);
    return m ? Number(m[1]) : Number.NaN;
  } finally {
    await fh.close();
  }
};
const latestSnap = () => {
  const files = readdirSync(SNAP_DIR)
    .filter((f) => f.endsWith(".heapsnapshot"))
    .map((f) => join(SNAP_DIR, f));
  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
};
// SIGUSR2 → V8 GC + dump; wait until a NEW snapshot file appears and stops growing.
const snapshot = async (pid, prevCount) => {
  const before = new Set(existsSync(SNAP_DIR) ? readdirSync(SNAP_DIR) : []);
  process.kill(pid, "SIGUSR2");
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    if (!existsSync(SNAP_DIR)) continue;
    const now = readdirSync(SNAP_DIR).filter((f) => !before.has(f) && f.endsWith(".heapsnapshot"));
    if (now.length > 0) {
      const file = join(SNAP_DIR, now[0]);
      let sz = -1;
      for (let s = 0; s < 30; s++) {
        await sleep(1000);
        const cur = statSync(file).size;
        if (cur === sz && cur > 0) break; // stopped growing → dump complete
        sz = cur;
      }
      return { file, size: sz, nodeCount: await readNodeCount(file) };
    }
  }
  throw new Error("heap snapshot never appeared (was --heapsnapshot-signal set?)");
};

// ── docker Postgres (isolate structural retention from dev InMemory data) ──────
let PG_STARTED = false;
let DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.log("=== ⓪ start Postgres (isolate structural leak from InMemory data) ===");
  sh("docker", ["rm", "-f", "everdict-heapdiff-pg"], { stdio: "ignore" });
  sh("docker", [
    "run",
    "-d",
    "--name",
    "everdict-heapdiff-pg",
    "-p",
    "127.0.0.1::5432",
    "-e",
    "POSTGRES_USER=everdict",
    "-e",
    "POSTGRES_PASSWORD=everdict",
    "-e",
    "POSTGRES_DB=everdict",
    "postgres:16-alpine",
  ]);
  PG_STARTED = true;
  for (let i = 0; i < 30; i++) {
    try {
      sh("docker", ["exec", "everdict-heapdiff-pg", "pg_isready", "-U", "everdict"], { stdio: "ignore" });
      break;
    } catch {
      await sleep(1000);
    }
  }
  const pgPort = sh("docker", ["port", "everdict-heapdiff-pg", "5432"]).trim().split("\n")[0].split(":").pop();
  DATABASE_URL = `postgresql://everdict:everdict@127.0.0.1:${pgPort}/everdict`;
}

rmSync(SNAP_DIR, { recursive: true, force: true });
sh("mkdir", ["-p", SNAP_DIR]);

console.log(`=== heap-diff churn proof — ${ROUNDS} rounds, snapshots in ${SNAP_DIR} ===`);
// cwd = SNAP_DIR so --heapsnapshot-signal dumps land there; the CP entry is an absolute path.
const cp2 = spawn("node", [join(ROOT, "apps/api/dist/main.js")], {
  cwd: SNAP_DIR,
  env: {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --heapsnapshot-signal=SIGUSR2`.trim(),
    PORT,
    EVERDICT_REQUIRE_AUTH: "",
    KEYCLOAK_ISSUER: "",
    DATABASE_URL,
    EVERDICT_MCP_SESSION_IDLE_MS: "15000", // short so the idle-eviction sweep runs mid-churn
    EVERDICT_SELF_HOSTED_QUEUE_TIMEOUT_MS: "30000",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
cp2.stderr.on("data", (d) => {
  const s = String(d);
  if (/error|unhandled/i.test(s)) process.stderr.write(`  [cp] ${s}`);
});
let ok = false;
const cliProcs = [];
try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await sleep(1000);
    try {
      up = (await fetch(`${BASE}/datasets`, { headers: H })).status === 200;
    } catch {}
  }
  if (!up) throw new Error("control plane failed to start");

  await post("/harness-templates", {
    kind: "command",
    category: "cli-agent",
    id: "hd-sh",
    version: "1",
    setup: [],
    command: 'bash -lc "echo hd > out.txt && cat out.txt"',
    env: {},
    trace: { kind: "none" },
  });
  await post("/harnesses", { template: { id: "hd-sh", version: "1" }, id: "hd-sh", version: "1.0.0", pins: {} });
  await post("/datasets", {
    id: "hd-ds",
    version: "1.0.0",
    cases: [
      {
        id: "hd-0",
        env: { kind: "repo", source: { files: {} } },
        task: "hd",
        graders: [{ id: "tests-pass", config: { cmd: "grep -q hd out.txt" } }],
        timeoutSec: 60,
        tags: ["hd"],
      },
    ],
  });

  const churnRound = async (r) => {
    const paired = await post("/runners", { label: `hd-${r}`, capabilities: ["git"] });
    const { token, runner } = paired.json;
    const proc = spawn(
      "node",
      [join(ROOT, "apps/cli/dist/main.js"), "runner", "--pair", token, "--api-url", BASE, "--poll-interval-ms", "300"],
      { cwd: ROOT, env: { ...process.env }, stdio: ["ignore", "ignore", "ignore"] },
    );
    cliProcs.push(proc);
    await sleep(1200);
    const sub = await post("/scorecards", {
      dataset: { id: "hd-ds", version: "1.0.0" },
      harness: { id: "hd-sh" },
      runtime: `self:${runner.id}`,
      concurrency: 1,
    });
    for (let i = 0; i < 40; i++) {
      await sleep(800);
      const rec = await get(`/scorecards/${sub.json.id}`);
      if (rec.status === "succeeded" || rec.status === "failed") break;
    }
    try {
      proc.kill("SIGKILL");
    } catch {}
    await fetch(`${BASE}/runners/${runner.id}`, { method: "DELETE", headers: H }).catch(() => {});
  };

  console.log("=== warm-up (10 rounds) then baseline snapshot ===");
  for (let r = 0; r < 10; r++) await churnRound(r);
  await sleep(20_000); // let the idle-eviction sweep reclaim the warm-up sessions before the baseline
  const snap1 = await snapshot(cp2.pid);
  console.log(`  snapshot1: node_count=${snap1.nodeCount} size=${(snap1.size / 1e6).toFixed(1)}MB`);

  console.log(`=== churn ${ROUNDS} rounds ===`);
  const t0 = Date.now();
  for (let r = 10; r < 10 + ROUNDS; r++) {
    await churnRound(r);
    if ((r - 10) % 30 === 0) console.log(`  round ${r - 10}/${ROUNDS} · t=${Math.round((Date.now() - t0) / 1000)}s`);
  }
  await sleep(25_000); // let eviction + GC settle before the second snapshot
  const snap2 = await snapshot(cp2.pid);
  console.log(`  snapshot2: node_count=${snap2.nodeCount} size=${(snap2.size / 1e6).toFixed(1)}MB`);

  console.log("\n=== verdict ===");
  const nodeGrowth = (snap2.nodeCount - snap1.nodeCount) / snap1.nodeCount;
  const sizeGrowth = (snap2.size - snap1.size) / snap1.size;
  console.log(`  live node_count: ${snap1.nodeCount} → ${snap2.nodeCount} (${(nodeGrowth * 100).toFixed(1)}%)`);
  console.log(
    `  snapshot size:   ${(snap1.size / 1e6).toFixed(1)}MB → ${(snap2.size / 1e6).toFixed(1)}MB (${(sizeGrowth * 100).toFixed(1)}%)`,
  );
  // Post-GC retained objects must NOT scale with churn. A per-round leak over ${ROUNDS} rounds would grow
  // node_count by many ×; a leak-free run stays within a small band (warm-up variance / lazy caches). 15% cap.
  check(
    nodeGrowth < 0.15,
    `live node_count did not scale with churn (Δ ${(nodeGrowth * 100).toFixed(1)}% over ${ROUNDS} rounds)`,
  );
  check(sizeGrowth < 0.2, `retained heap size did not scale with churn (Δ ${(sizeGrowth * 100).toFixed(1)}%)`);

  ok = failures.length === 0;
  console.log(
    ok
      ? "\n✅ PASS — post-GC retained objects stay flat across runner churn: no class accumulates (leak-free)."
      : `\n❌ FAIL — ${failures.length} check(s):\n${failures.map((f) => `   · ${f}`).join("\n")}`,
  );
} catch (e) {
  console.error("error:", e instanceof Error ? (e.stack ?? e.message) : e);
} finally {
  for (const p of cliProcs) {
    try {
      p.kill("SIGKILL");
    } catch {}
  }
  try {
    cp2.kill("SIGKILL");
  } catch {}
  if (PG_STARTED && !process.env.KEEP) {
    try {
      sh("docker", ["rm", "-f", "everdict-heapdiff-pg"], { stdio: "ignore" });
    } catch {}
  }
  if (!process.env.KEEP) rmSync(SNAP_DIR, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
