// Live stress matrix: **mixed harness kinds × mixed runner fleet under deliberate overload**, with an
// end-to-end case success-rate verdict (target ≥ 99%). The break-it→fix-it loop driver.
//
// Matrix:
//   harnesses — A: docker service topology (sse-relay-bench) · B: the SAME topology whose client-host
//   REQUIRES a Windows node (sse-relay-bench-win, requires.os) · C: command harness (sh-bench,
//   in-process LocalDriver noise).
//   fleet — 3 CLI runner processes (1 worker) + 1 CLI runner process (4 workers) + RunnerHost
//   "desktop core" (4 workers, auto capabilities) + RunnerHost "win node" (2 workers, advertises
//   os-windows) — B jobs must route ONLY to the win runner (lease-time capability gate under load).
//   load — wave 1 queues 40 scorecards at once; wave 2 spikes 20 more while the fleet is saturated.
//
// Verdict (all must hold):
//   · every scorecard terminal, end-to-end case pass rate ≥ 99% (per-kind rates reported);
//   · 100% of B cases carry the win runner's provenance (placement correctness under load);
//   · zero cross-session leakage in every topology case; all runners alive at the end.
// Failures are dumped to stress-failures.json (harness/case/failure-class/score detail/runner) — the
// input for the next fix iteration.
//
// Usage: node scripts/live/sse-relay-stress-matrix.mjs   (docker + api/cli/self-hosted-runner dists)
//   WAVE1_A/WAVE1_CMD/WAVE1_B, WAVE2_A/WAVE2_CMD/WAVE2_B override wave sizes. KEEP=1 keeps topologies.
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

const PORT = process.env.CP_PORT ?? "8796";
const BASE = `http://127.0.0.1:${PORT}`;
const H = { "content-type": "application/json", "x-everdict-tenant": "default" };
const ROOT = new URL("../..", import.meta.url).pathname;
const BUNDLE_DIR = `${ROOT}examples/bundles/sse-relay-bench`;
const NET_A = "everdict-sse-relay-bench-1.0.0";
const NET_B = "everdict-sse-relay-bench-win-1.0.0";
const WAVE1 = {
  A: Number(process.env.WAVE1_A ?? 16),
  CMD: Number(process.env.WAVE1_CMD ?? 16),
  B: Number(process.env.WAVE1_B ?? 8),
};
const WAVE2 = {
  A: Number(process.env.WAVE2_A ?? 8),
  CMD: Number(process.env.WAVE2_CMD ?? 8),
  B: Number(process.env.WAVE2_B ?? 4),
};
const BUDGET_MIN = 45;
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
const serviceStats = async (network, container, port) => {
  const out = sh("docker", ["port", `${network}-${container}`, String(port)])
    .trim()
    .split("\n")[0];
  return (await fetch(`http://127.0.0.1:${out.split(":").pop()}/stats`)).json();
};

console.log("=== ⓪ build images + clean leftovers ===");
sh("docker", ["build", "-q", "-t", "sse-relay-command:v1", `${BUNDLE_DIR}/command-server`], { stdio: "inherit" });
sh("docker", ["build", "-q", "-t", "sse-relay-relay:v1", `${BUNDLE_DIR}/relay-server`], { stdio: "inherit" });
sh(
  "docker",
  ["build", "-q", "-t", "sse-relay-client-host:v1", "-f", `${BUNDLE_DIR}/client-host/Dockerfile`, BUNDLE_DIR],
  { stdio: "inherit" },
);
for (const net of [NET_A, NET_B]) {
  const leftover = sh("docker", ["ps", "-aq", "--filter", `name=${net}`]).trim();
  if (leftover) sh("docker", ["rm", "-f", ...leftover.split("\n")], { stdio: "ignore" });
  try {
    sh("docker", ["network", "rm", net], { stdio: "ignore" });
  } catch {}
}

console.log(`\n=== ① control plane (dev, :${PORT}) ===`);
const cp = spawn("node", ["apps/api/dist/main.js"], {
  cwd: ROOT,
  env: { ...process.env, PORT, EVERDICT_REQUIRE_AUTH: "", KEYCLOAK_ISSUER: "", DATABASE_URL: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
cp.stderr.on("data", (d) => process.stderr.write(`  [cp] ${d}`));
const cliProcs = [];
const hosts = [];
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

  console.log("\n=== ② fleet: 3×CLI(1w) + 1×CLI(4w) + RunnerHost desktop(4w) + RunnerHost win(2w, os-windows) ===");
  const pair = async (label) => {
    const paired = await post("/runners", { label, capabilities: ["git"] });
    if (!paired.json.token || !paired.json.runner?.id)
      throw new Error(`pairing ${label} failed: ${JSON.stringify(paired.json)}`);
    return { id: paired.json.runner.id, token: paired.json.token };
  };
  const spawnCli = (i, token, extra = []) => {
    const proc = spawn(
      "node",
      [
        "apps/cli/dist/main.js",
        "runner",
        "--pair",
        token,
        "--api-url",
        BASE,
        "--poll-interval-ms",
        "500",
        "--ready-timeout-ms",
        "180000",
        ...extra,
      ],
      { cwd: ROOT, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
    );
    proc.stderr.on("data", (d) => process.stderr.write(`  [cli${i}] ${d}`));
    cliProcs.push(proc);
  };
  const cliIds = [];
  for (let i = 0; i < 3; i++) {
    const r = await pair(`stress-cli-${i}`);
    cliIds.push(r.id);
    spawnCli(i, r.token);
  }
  const cliWide = await pair("stress-cli-wide");
  cliIds.push(cliWide.id);
  spawnCli(3, cliWide.token, ["--max-concurrent", "4"]);

  const shr = await import(pathToFileURL(`${ROOT}packages/self-hosted-runner/dist/index.js`).href);
  const desktop = await pair("stress-desktop");
  const desktopHost = new shr.RunnerHost({
    apiUrl: BASE,
    token: desktop.token,
    maxConcurrent: 4,
    log: (m) => process.stderr.write(`  [desktop] ${m}\n`),
  });
  await desktopHost.start();
  hosts.push(desktopHost);
  // The simulated Windows node: same engine, but ADVERTISES os-windows (capability override) — the only
  // runner eligible for harness B. (Linux images actually run; the axis under test is placement routing.)
  const win = await pair("stress-win-node");
  const winHost = new shr.RunnerHost({
    apiUrl: BASE,
    token: win.token,
    maxConcurrent: 2,
    capabilities: ["git", "docker", "browser", "topology", "os-windows"],
    log: (m) => process.stderr.write(`  [win] ${m}\n`),
  });
  await winHost.start();
  hosts.push(winHost);
  console.log(`  cli: ${cliIds.join(", ")}\n  desktop: ${desktop.id}\n  win: ${win.id}`);
  await sleep(3500);

  console.log("\n=== ③ bundles + topology warmups (A on the pool, B on the win lane) ===");
  for (const file of ["bundle.json", "stress-bundle.json"]) {
    const applied = await post("/bundles/apply", JSON.parse(readFileSync(`${BUNDLE_DIR}/${file}`, "utf8")));
    if ((applied.json.results ?? []).some((r) => r.status === "failed"))
      throw new Error(`${file} apply failed: ${JSON.stringify(applied.json.results)}`);
  }
  const warm = async (harness, label) => {
    const sub = await post("/scorecards", {
      dataset: { id: "sse-relay-parallel", version: "1.0.0" },
      harness: { id: harness },
      runtime: "self",
      cases: { limit: 1 },
    });
    if (!sub.json.id) throw new Error(`${label} warmup submit failed: ${JSON.stringify(sub.json)}`);
    let rec;
    for (let i = 0; i < 180; i++) {
      await sleep(2000);
      rec = await get(`/scorecards/${sub.json.id}`);
      if (rec.status === "succeeded" || rec.status === "failed") break;
    }
    check(rec.status === "succeeded", `${label} warmup succeeded`);
    return rec;
  };
  await warm("sse-relay-bench", "A");
  const warmB = await warm("sse-relay-bench-win", "B(win)");
  check(
    (warmB.scorecard?.results ?? []).every((r) => r.provenance?.runner === win.id),
    "B warmup ran on the win runner",
  );

  console.log(`\n=== ④ wave 1: ${WAVE1.A}×A + ${WAVE1.CMD}×cmd + ${WAVE1.B}×B(win) queued at once ===`);
  const t0 = Date.now();
  const cards = [];
  const submit = async (kind) => {
    const body =
      kind === "cmd"
        ? {
            dataset: { id: "sh-echo-parallel", version: "1.0.0" },
            harness: { id: "sh-bench" },
            runtime: "self",
            concurrency: 8,
          }
        : kind === "B"
          ? {
              dataset: { id: "sse-relay-parallel", version: "1.0.0" },
              harness: { id: "sse-relay-bench-win" },
              runtime: "self",
              concurrency: 4,
              cases: { limit: 4 },
            }
          : {
              dataset: { id: "sse-relay-parallel", version: "1.0.0" },
              harness: { id: "sse-relay-bench" },
              runtime: "self",
              concurrency: 8,
            };
    const r = await post("/scorecards", body);
    if (!r.json.id) throw new Error(`submit ${kind} failed (${r.status}): ${JSON.stringify(r.json)}`);
    cards.push({ id: r.json.id, kind });
  };
  const wave = async (w) => {
    for (let i = 0; i < w.A; i++) await submit("A");
    for (let i = 0; i < w.CMD; i++) await submit("cmd");
    for (let i = 0; i < w.B; i++) await submit("B");
  };
  await wave(WAVE1);
  console.log(`  wave 1 submitted (${cards.length} cards) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Spike while saturated — the second wave lands on a fleet already at capacity.
  setTimeout(() => {
    wave(WAVE2)
      .then(() => console.log(`  wave 2 spike submitted (+${WAVE2.A + WAVE2.CMD + WAVE2.B} cards)`))
      .catch((e) => console.log(`  wave 2 submit FAILED: ${e.message}`));
  }, 90_000);

  const expectedCards = WAVE1.A + WAVE1.CMD + WAVE1.B + WAVE2.A + WAVE2.CMD + WAVE2.B;
  const expectedCases = (WAVE1.A + WAVE2.A) * 8 + (WAVE1.CMD + WAVE2.CMD) * 8 + (WAVE1.B + WAVE2.B) * 4;
  const terminal = new Map();
  const deadline = Date.now() + BUDGET_MIN * 60_000;
  while ((terminal.size < expectedCards || cards.length < expectedCards) && Date.now() < deadline) {
    await sleep(15_000);
    let settled = 0;
    const perKind = { A: 0, cmd: 0, B: 0 };
    for (const card of cards) {
      if (terminal.has(card.id)) {
        settled += terminal.get(card.id).scorecard?.results?.length ?? 0;
        continue;
      }
      const rec = await get(`/scorecards/${card.id}`);
      settled += rec.scorecard?.results?.length ?? 0;
      if (rec.status === "succeeded" || rec.status === "failed") {
        terminal.set(card.id, rec);
        perKind[card.kind] += 1;
      }
    }
    const done = { A: 0, cmd: 0, B: 0 };
    for (const c of cards) if (terminal.has(c.id)) done[c.kind] += 1;
    const cliAlive = cliProcs.filter((p) => p.exitCode === null).length;
    console.log(
      `  t=${Math.round((Date.now() - t0) / 1000)}s cards=${terminal.size}/${cards.length} (A=${done.A} cmd=${done.cmd} B=${done.B}) cases=${settled}/${expectedCases} cli-alive=${cliAlive}/4 desktop=${desktopHost.status().state} win=${winHost.status().state}`,
    );
  }
  const wallMin = ((Date.now() - t0) / 60_000).toFixed(1);

  console.log(`\n=== ⑤ verdict (wall ${wallMin} min) ===`);
  check(cards.length === expectedCards, `all ${expectedCards} scorecards submitted (got ${cards.length})`);
  check(terminal.size === cards.length, `all scorecards terminal (${terminal.size}/${cards.length})`);

  const caseRows = [];
  for (const card of cards) {
    const rec = terminal.get(card.id);
    if (!rec) continue;
    for (const r of rec.scorecard?.results ?? []) {
      const score =
        card.kind === "cmd"
          ? (r.scores ?? []).find((s) => s.metric === "tests_pass")
          : (r.scores ?? []).find((s) => s.graderId === "answer-match");
      let summary = {};
      try {
        summary = JSON.parse(r.snapshot?.output ?? "{}");
      } catch {}
      caseRows.push({
        card: card.id,
        kind: card.kind,
        caseId: r.caseId,
        pass: score?.pass === true,
        detail: score?.detail,
        runner: r.provenance?.runner,
        failure: r.failure,
        leaked: summary.leaked,
        cardStatus: rec.status,
      });
    }
    // A failed/short card contributes its missing cases as failures (they never produced results).
    const got = (rec.scorecard?.results ?? []).length;
    const want = card.kind === "B" ? 4 : 8;
    for (let i = got; i < want; i++)
      caseRows.push({ card: card.id, kind: card.kind, caseId: `(missing-${i})`, pass: false, cardStatus: rec.status });
  }
  const total = caseRows.length;
  const passed = caseRows.filter((r) => r.pass).length;
  const rate = total > 0 ? passed / total : 0;
  for (const kind of ["A", "cmd", "B"]) {
    const rows = caseRows.filter((r) => r.kind === kind);
    const p = rows.filter((r) => r.pass).length;
    console.log(`  ${kind}: ${p}/${rows.length} (${rows.length ? ((100 * p) / rows.length).toFixed(1) : "-"}%)`);
  }
  check(total === expectedCases, `${expectedCases} case results accounted for (got ${total})`);
  check(rate >= 0.99, `END-TO-END SUCCESS RATE ≥ 99% (got ${(rate * 100).toFixed(2)}% — ${passed}/${total})`);

  const bRows = caseRows.filter((r) => r.kind === "B" && r.runner);
  check(
    bRows.length > 0 && bRows.every((r) => r.runner === win.id),
    `every B case ran on the win runner (${bRows.filter((r) => r.runner === win.id).length}/${bRows.length})`,
  );
  const leakTotal = caseRows.reduce((n, r) => n + (r.leaked ?? 0), 0);
  check(leakTotal === 0, `zero cross-session leakage under overload (leaked=${leakTotal})`);
  check(
    cliProcs.every((p) => p.exitCode === null),
    "all CLI runner processes alive after the stress",
  );
  check(
    desktopHost.status().state !== "off" && winHost.status().state !== "off",
    `both RunnerHosts alive (desktop=${desktopHost.status().state}, win=${winHost.status().state})`,
  );
  const byRunner = {};
  for (const r of caseRows) if (r.runner) byRunner[r.runner] = (byRunner[r.runner] ?? 0) + 1;
  console.log(
    `  distribution: ${Object.entries(byRunner)
      .map(([id, n]) => `${id === win.id ? "win" : id === desktop.id ? "desktop" : `cli(${id.slice(0, 8)})`}=${n}`)
      .join(" · ")}`,
  );
  const statsA = await serviceStats(NET_A, "client-host", 8002).catch(() => ({}));
  const statsB = await serviceStats(NET_B, "client-host", 8002).catch(() => ({}));
  console.log(`  topology sessions: A peak=${statsA.peak} · B(win) peak=${statsB.peak}`);

  const failed = caseRows.filter((r) => !r.pass);
  const dump = `${process.env.TMPDIR ?? "/tmp"}/stress-failures.json`;
  writeFileSync(dump, JSON.stringify(failed, null, 2));
  if (failed.length > 0) {
    console.log(`  ${failed.length} failing case(s) dumped to ${dump}; first few:`);
    for (const f of failed.slice(0, 8))
      console.log(
        `   · [${f.kind}] ${f.caseId} card=${f.card.slice(0, 8)} status=${f.cardStatus} class=${f.failure?.class ?? "-"} detail=${String(f.detail ?? "").slice(0, 100)}`,
      );
  }

  ok = failures.length === 0;
  console.log(
    ok
      ? `\n✅ PASS — mixed matrix survived the overload: ${(rate * 100).toFixed(2)}% end-to-end (${passed}/${total}), win-lane placement exact, fleet intact.`
      : `\n❌ FAIL — ${failures.length} check(s) failed:\n${failures.map((f) => `   · ${f}`).join("\n")}`,
  );
} catch (e) {
  console.error("error:", e instanceof Error ? (e.stack ?? e.message) : e);
} finally {
  for (const h of hosts) {
    try {
      await h.stop();
    } catch {}
  }
  for (const p of cliProcs) {
    try {
      p.kill("SIGKILL");
    } catch {}
  }
  try {
    cp.kill("SIGKILL");
  } catch {}
  if (!process.env.KEEP) {
    for (const net of [NET_A, NET_B]) {
      try {
        const names = sh("docker", ["ps", "-aq", "--filter", `name=${net}`]).trim();
        if (names) sh("docker", ["rm", "-f", ...names.split("\n")], { stdio: "ignore" });
        sh("docker", ["network", "rm", net], { stdio: "ignore" });
      } catch {}
    }
  }
}
process.exit(ok ? 0 : 1);
