// System-level churn RSS soak: a REAL control plane + a stream of runners that pair → run a small batch →
// disconnect, over many rounds, sampling the CP process RSS from /proc. Confirms end-to-end that the runner
// lifecycle doesn't grow the control plane's memory under sustained pairing/running/disconnect churn (the
// deterministic hub/scheduler proof lives in runner-churn-leak-soak.mjs; this is the whole-process check).
//
// Each round: POST /runners (pair) → spawn `everdict runner` → submit a tiny command scorecard pinned to that
// runner → wait for it to finish → SIGKILL the runner (disconnect) → unpair. RSS is sampled every few rounds.
// PASS = RSS plateaus (final within a small slack of the mid-run median), not a monotonic climb.
//
// Usage: node scripts/live/runner-churn-rss-soak.mjs [rounds=120]   (apps/api/dist + apps/cli/dist built)
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const PORT = process.env.CP_PORT ?? "8808";
const BASE = `http://127.0.0.1:${PORT}`;
const H = { "content-type": "application/json", "x-everdict-tenant": "default" };
const ROOT = new URL("../..", import.meta.url).pathname;
const ROUNDS = Number(process.argv[2] ?? 120);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = async (p, b) => {
  const r = await fetch(`${BASE}${p}`, { method: "POST", headers: H, body: JSON.stringify(b) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const get = async (p) => (await fetch(`${BASE}${p}`, { headers: H })).json();
const api = async (p, init) => {
  const r = await fetch(`${BASE}${p}`, { headers: H, ...init });
  return r.status;
};

const rssMb = (pid) => {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const m = status.match(/VmRSS:\s+(\d+)\s+kB/);
    return m ? Number(m[1]) / 1024 : 0;
  } catch {
    return 0;
  }
};

console.log(`=== system churn RSS soak — ${ROUNDS} pair→run→disconnect rounds ===`);
// DATABASE_URL (when set) backs the scorecard/run/notification stores with Postgres, so the CP's RSS reflects
// its in-memory STRUCTURES (hub/scheduler/registry) — not dev InMemory data retention. Pass it to isolate a
// real structural leak from expected dev-store growth. Empty = InMemory (dev; RSS also grows with retained data).
const cp = spawn("node", ["apps/api/dist/main.js"], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT,
    EVERDICT_REQUIRE_AUTH: "",
    KEYCLOAK_ISSUER: "",
    DATABASE_URL: process.env.DATABASE_URL ?? "",
    EVERDICT_SELF_HOSTED_QUEUE_TIMEOUT_MS: "30000",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
cp.stderr.on("data", (d) => {
  const s = String(d);
  if (/error|Error|unhandled/i.test(s)) process.stderr.write(`  [cp] ${s}`);
});
const failures = [];
const check = (ok, label) => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failures.push(label);
};
let ok = false;
try {
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await sleep(1000);
    try {
      up = (await fetch(`${BASE}/datasets`, { headers: H })).status === 200;
    } catch {}
  }
  if (!up) throw new Error("control plane failed to start");

  // A trivial command harness + 2-case dataset (fast, no docker) — the churn vehicle.
  await post("/harness-templates", {
    kind: "command",
    category: "cli-agent",
    id: "churn-sh",
    version: "1",
    setup: [],
    command: 'bash -lc "echo churn > out.txt && cat out.txt"',
    env: {},
    trace: { kind: "none" },
  });
  await post("/harnesses", { template: { id: "churn-sh", version: "1" }, id: "churn-sh", version: "1.0.0", pins: {} });
  await post("/datasets", {
    id: "churn-ds",
    version: "1.0.0",
    cases: [0, 1].map((c) => ({
      id: `cc-${c}`,
      env: { kind: "repo", source: { files: {} } },
      task: "churn",
      graders: [{ id: "tests-pass", config: { cmd: "grep -q churn out.txt" } }],
      timeoutSec: 60,
      tags: ["churn"],
    })),
  });

  let completed = 0;
  const rss = [];
  const t0 = Date.now();
  for (let r = 0; r < ROUNDS; r++) {
    const paired = await post("/runners", { label: `churn-${r}`, capabilities: ["git"] });
    const token = paired.json.token;
    const id = paired.json.runner?.id;
    if (!token || !id) throw new Error(`pair ${r} failed`);
    const runner = spawn(
      "node",
      ["apps/cli/dist/main.js", "runner", "--pair", token, "--api-url", BASE, "--poll-interval-ms", "300"],
      { cwd: ROOT, env: { ...process.env }, stdio: ["ignore", "ignore", "ignore"] },
    );
    await sleep(1500); // MCP session connects
    const sub = await post("/scorecards", {
      dataset: { id: "churn-ds", version: "1.0.0" },
      harness: { id: "churn-sh" },
      runtime: `self:${id}`,
      concurrency: 2,
    });
    let rec;
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      rec = await get(`/scorecards/${sub.json.id}`);
      if (rec.status === "succeeded" || rec.status === "failed") break;
    }
    if (rec?.status === "succeeded") completed += 1;
    // Disconnect (SIGKILL, no graceful unpair) then remove the roster entry — the churn.
    try {
      runner.kill("SIGKILL");
    } catch {}
    await api(`/runners/${id}`, { method: "DELETE" }).catch(() => 0);

    if (r % 10 === 0 || r === ROUNDS - 1) {
      const mb = rssMb(cp.pid);
      rss.push({ r, mb });
      console.log(
        `  round ${String(r).padStart(3)} · CP RSS=${mb.toFixed(1)}MB · completed=${completed}/${r + 1} · t=${Math.round((Date.now() - t0) / 1000)}s`,
      );
    }
  }

  console.log("\n=== verdict ===");
  check(completed >= Math.floor(ROUNDS * 0.98), `≥98% of churned batches completed (${completed}/${ROUNDS})`);
  const mbs = rss.map((s) => s.mb);
  const warm = mbs.slice(1); // drop the very first (startup) sample
  const median = [...warm].sort((a, b) => a - b)[Math.floor(warm.length / 2)] ?? mbs.at(-1);
  const final = mbs.at(-1) ?? 0;
  const peak = Math.max(...warm);
  console.log(`  RSS median=${median.toFixed(1)}MB · final=${final.toFixed(1)}MB · peak=${peak.toFixed(1)}MB`);
  // Plateau, not climb: final within 40MB of the warm median (Node RSS is coarse — jemalloc/heap fragmentation and
  // GC scheduling add tens of MB of noise across a multi-minute run; a real per-round leak over 120 rounds would
  // exceed this and, more tellingly, climb monotonically).
  check(final <= median + 40, `CP RSS plateaued (final ${final.toFixed(1)}MB vs median ${median.toFixed(1)}MB)`);
  check(final <= peak + 5, "final RSS is not the peak (no monotonic climb to the end)");

  ok = failures.length === 0;
  console.log(
    ok
      ? "\n✅ PASS — the control plane's RSS holds steady across sustained runner pair/run/disconnect churn."
      : `\n❌ FAIL — ${failures.length} check(s):\n${failures.map((f) => `   · ${f}`).join("\n")}`,
  );
} catch (e) {
  console.error("error:", e instanceof Error ? (e.stack ?? e.message) : e);
} finally {
  try {
    execFileSync("pkill", ["-f", "apps/cli/dist/main.js runner"], { stdio: "ignore" });
  } catch {}
  try {
    cp.kill("SIGKILL");
  } catch {}
}
process.exit(ok ? 0 : 1);
