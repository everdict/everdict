// Live e2e: *user self-serve* — via the control-plane HTTP API alone: (1) add a benchmark → (2) register your own harness → (3) measure.
// User scenario:
//   ① POST /datasets  : add external benchmark 'pinch' (github.com/pinchbench/skill, PinchBench building-dashboards) as a dataset
//      → the platform accepts an arbitrary external benchmark (extensibility). (pinch=coding-agent benchmark, so measuring with GUI hermes is meaningless —
//       the add/register itself proves self-serve. Meaningful measurement uses a hermes-fit benchmark.)
//   ② POST /harnesses : register the user's 'hermes-desktop' (os-use command harness)
//   ③ POST /datasets  : add a hermes-fit benchmark (SSH connection)  +  POST /scorecards : measure it with hermes-desktop
//      → the control plane brings up a hermes image container on the docker runtime, runs real os-use → VLM judge grade → Scorecard.
//   ④ poll GET /scorecards/:id → result (case pass + aggregate).
// This script starts the control plane in dev mode (no auth required). User=tenant default (x-everdict-tenant).
//
// Prerequisites: hermes image (everdict-hermes-dispatch:demo) built. LiteLLM (:4000) running (VLM judge). apps/api/dist built.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const PORT = process.env.CP_PORT ?? "8788";
const BASE = `http://127.0.0.1:${PORT}`;
const H = { "content-type": "application/json", "x-everdict-tenant": "default" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function masterKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  try {
    const t = readFileSync(new URL("../../../../infra/litellm/.env", import.meta.url), "utf8");
    return (t.match(/^LITELLM_MASTER_KEY=(.+)$/m) || [])[1]?.trim();
  } catch {
    return undefined;
  }
}
const KEY = masterKey();
if (!KEY) {
  console.error("no LLM key.");
  process.exit(2);
}

const post = async (path, body) => {
  const r = await fetch(`${BASE}${path}`, { method: "POST", headers: H, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

// ── start control plane (dev: no auth required, VLM judge env, docker runtime seed) ──
console.log(`=== start control plane (apps/api, dev mode, :${PORT}) ===`);
const cp = spawn("node", ["apps/api/dist/main.js"], {
  cwd: new URL("../..", import.meta.url).pathname,
  env: {
    ...process.env,
    PORT,
    OPENAI_API_KEY: KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? "http://localhost:4000/v1",
    EVERDICT_JUDGE_MODEL: process.env.EVERDICT_JUDGE_MODEL ?? "gpt-5.4-mini",
    EVERDICT_REQUIRE_AUTH: "", // dev fallback (tenant=default)
    KEYCLOAK_ISSUER: "", // OIDC disabled (dev)
    DATABASE_URL: "", // in-memory store
  },
  stdio: ["ignore", "pipe", "pipe"],
});
cp.stdout.on("data", (d) => process.stdout.write(`  [cp] ${d}`));
cp.stderr.on("data", (d) => process.stderr.write(`  [cp-err] ${d}`));
const shutdown = () => {
  try {
    cp.kill("SIGKILL");
  } catch {}
};

let ok = false;
try {
  // Wait for startup
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await sleep(1000);
    try {
      up = (await fetch(`${BASE}/datasets`, { headers: H })).status === 200;
    } catch {}
  }
  if (!up) throw new Error("control plane failed to start");
  console.log("control plane up.\n");

  // ── ① add external benchmark 'pinch' (PinchBench building-dashboards) ──
  console.log("=== ① user adds external benchmark 'pinch' (POST /datasets) ===");
  const pinch = {
    id: "pinch-building-dashboards",
    version: "1.0.0",
    description:
      "PinchBench(github.com/pinchbench/skill) building-dashboards — an LLM coding agent designs/builds an Axiom dashboard.",
    tags: ["pinchbench", "coding-agent", "external"],
    cases: [
      {
        id: "api-health-dashboard",
        env: { kind: "prompt" },
        task: "Using the building-dashboards skill, design an Axiom dashboard for API health: panels for p95/p99 latency, error rate, and request volume. Output the dashboard JSON.",
        graders: [
          {
            id: "judge",
            config: {
              rubric:
                "PASS if the output is a valid Axiom dashboard covering p95/p99 latency, error rate, and request volume panels.",
            },
          },
        ],
        timeoutSec: 300,
        tags: ["pinchbench"],
      },
    ],
  };
  const r1 = await post("/datasets", pinch);
  console.log(`  → ${r1.status} ${JSON.stringify(r1.json)}`);

  // ── ② register the user's hermes-desktop harness ──
  console.log("\n=== ② user registers the hermes-desktop harness (POST /harnesses) ===");
  const harness = {
    kind: "command",
    id: "hermes-desktop",
    version: "1.0.0",
    workDir: "/tmp",
    env: { DISPLAY: ":99" },
    setup: [],
    command: "node /agent.cjs {{task}}",
    trace: { kind: "none" },
  };
  const r2 = await post("/harnesses", harness);
  console.log(`  → ${r2.status} ${JSON.stringify(r2.json)}`);

  // ── ③ add a hermes-fit benchmark + measure ──
  console.log("\n=== ③ add a hermes-fit benchmark (SSH connection) + measure it with hermes-desktop ===");
  const hermesBench = {
    id: "hermes-ssh-bench",
    version: "1.0.0",
    description:
      "hermes-desktop os-use benchmark — connect to an SSH server (the agent fills the SSH form via real OS input so hermes opens the tunnel).",
    tags: ["os-use", "hermes", "ssh"],
    cases: [
      {
        id: "hermes-ssh-connect",
        env: {
          kind: "os-use",
          display: ":99",
          setup: [
            "mkdir -p /run/sshd /root/.ssh && chmod 700 /root/.ssh",
            "ssh-keygen -A",
            "test -f /root/.ssh/id_rsa || ssh-keygen -t ed25519 -f /root/.ssh/id_rsa -N '' -q",
            "cp /root/.ssh/id_rsa.pub /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys",
            "grep -q '^PermitRootLogin' /etc/ssh/sshd_config || echo 'PermitRootLogin prohibit-password' >> /etc/ssh/sshd_config",
            "/usr/sbin/sshd",
            'node -e \'require("http").createServer((q,s)=>{s.writeHead(200);s.end("ok")}).listen(8642,"127.0.0.1")\' >/tmp/health.log 2>&1 & sleep 1',
            "Xvfb :99 -screen 0 1280x900x24 -nolisten tcp >/tmp/xvfb.log 2>&1 & sleep 2",
            "cd /app && ENABLE_CDP=1 CDP_PORT=9222 DISPLAY=:99 ./node_modules/.bin/electron . --no-sandbox --disable-gpu --disable-dev-shm-usage >/tmp/electron.log 2>&1 & sleep 10",
          ],
          screenshotPath: "/tmp/osuse.png",
        },
        image: "everdict-hermes-dispatch:demo",
        task: "Connect Hermes to the SSH server at 127.0.0.1 as user root (key /root/.ssh/id_rsa).",
        graders: [
          {
            id: "judge",
            config: {
              useScreenshot: true,
              rubric:
                "PASS only if the app has advanced PAST the SSH connection form — e.g. a splash like 'Starting SSH tunnel…' or the main app screen (sidebar with Chat/Discover, an 'Ask anything' box) — with NO connection-error message.",
            },
          },
        ],
        timeoutSec: 300,
        tags: ["os-use", "ssh"],
      },
    ],
  };
  const r3 = await post("/datasets", hermesBench);
  console.log(`  → POST /datasets hermes-ssh-bench: ${r3.status} ${JSON.stringify(r3.json)}`);

  const r4 = await post("/scorecards", {
    dataset: { id: "hermes-ssh-bench", version: "1.0.0" },
    harness: { id: "hermes-desktop", version: "1.0.0" },
    runtime: "docker",
    judge: { provider: "openai", model: process.env.EVERDICT_JUDGE_MODEL ?? "gpt-5.4-mini" },
  });
  console.log(`  → POST /scorecards: ${r4.status} ${JSON.stringify(r4.json)}`);
  const scId = r4.json.id;
  if (!scId) throw new Error("no scorecard id");

  // ── ④ poll ──
  console.log("\n=== ④ poll the scorecard (hermes os-use running — Electron + VLM judge, a few minutes) ===");
  let rec;
  for (let i = 0; i < 120; i++) {
    await sleep(3000);
    const r = await fetch(`${BASE}/scorecards/${scId}`, { headers: H });
    rec = await r.json();
    process.stdout.write(`  status=${rec.status}\r`);
    if (rec.status === "succeeded" || rec.status === "failed") break;
  }
  console.log(`\n  final status: ${rec.status}`);
  if (rec.summary) console.log("  aggregate:", JSON.stringify(rec.summary));
  const cases = rec.scorecard?.results ?? [];
  for (const c of cases) {
    const j = c.scores?.find((s) => s.metric === "judge");
    console.log(
      `  case ${c.caseId}: judge=${j?.pass ? "PASS" : "FAIL"} (${j?.value}) — ${String(j?.detail ?? "").slice(0, 120)}`,
    );
  }

  ok = r1.status === 201 && r2.status === 201 && r3.status === 201 && r4.status === 202 && rec.status === "succeeded";
  console.log(
    ok
      ? "\n✅ self-serve e2e: using only the HTTP API, the user ① adds an external benchmark (pinch) → ② registers the hermes-desktop harness → " +
          "③ adds a hermes-fit benchmark + measures it (the control plane brings up the hermes image on the docker runtime, runs real os-use + VLM judge) → " +
          "④ receives the Scorecard. Proves the platform offers benchmark/harness-agnostic self-serve measurement."
      : "\n⚠️ does not match expectation (see status/response above)",
  );
} catch (e) {
  console.error("error:", e instanceof Error ? e.message : e);
} finally {
  shutdown();
  spawnSync("docker", ["ps", "-aq", "--filter", "ancestor=everdict-hermes-dispatch:demo"], { encoding: "utf8" });
  console.log("control plane stopped.");
}
process.exit(ok ? 0 : 1);
