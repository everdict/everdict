// 라이브 e2e: *유저 self-serve* — 컨트롤플레인 HTTP API 만으로 (1) 벤치마크 추가 → (2) 자기 하니스 등록 → (3) 측정.
// 유저 시나리오:
//   ① POST /datasets  : 외부 벤치마크 'pinch'(github.com/pinchbench/skill, PinchBench building-dashboards) 를 데이터셋으로 추가
//      → 플랫폼이 임의 외부 벤치마크를 받아들임(extensibility). (pinch=코딩 에이전트 벤치마크라 GUI hermes 로는 측정 무의미 —
//       추가/등록 자체가 self-serve 입증. 의미있는 측정은 hermes-적합 벤치마크로.)
//   ② POST /harnesses : 유저의 'hermes-desktop'(os-use command 하니스) 등록
//   ③ POST /datasets  : hermes-적합 벤치마크(SSH 연결) 추가  +  POST /scorecards : 그걸 hermes-desktop 으로 측정
//      → 컨트롤플레인이 docker 런타임으로 hermes 이미지 컨테이너를 띄워 실 os-use 실행 → VLM judge 채점 → Scorecard.
//   ④ GET /scorecards/:id 폴링 → 결과(케이스 pass + 집계).
// 컨트롤플레인은 이 스크립트가 dev 모드(auth 미요구)로 기동. 유저=tenant default(x-everdict-tenant).
//
// 사전: hermes 이미지(everdict-hermes-dispatch:demo) 빌드됨. LiteLLM(:4000) 가동(VLM judge). apps/api/dist 빌드됨.
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
  console.error("LLM 키 없음.");
  process.exit(2);
}

const post = async (path, body) => {
  const r = await fetch(`${BASE}${path}`, { method: "POST", headers: H, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

// ── 컨트롤플레인 기동(dev: auth 미요구, VLM judge env, docker 런타임 시드) ──
console.log(`=== 컨트롤플레인 기동 (apps/api, dev 모드, :${PORT}) ===`);
const cp = spawn("node", ["apps/api/dist/main.js"], {
  cwd: new URL("../..", import.meta.url).pathname,
  env: {
    ...process.env,
    PORT,
    OPENAI_API_KEY: KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? "http://localhost:4000/v1",
    EVERDICT_JUDGE_MODEL: process.env.EVERDICT_JUDGE_MODEL ?? "gpt-5.4-mini",
    EVERDICT_REQUIRE_AUTH: "", // dev fallback (tenant=default)
    KEYCLOAK_ISSUER: "", // OIDC 비활성(dev)
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
  // 기동 대기
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await sleep(1000);
    try {
      up = (await fetch(`${BASE}/datasets`, { headers: H })).status === 200;
    } catch {}
  }
  if (!up) throw new Error("control plane 기동 실패");
  console.log("control plane up.\n");

  // ── ① 외부 벤치마크 'pinch' 추가 (PinchBench building-dashboards) ──
  console.log("=== ① 유저가 외부 벤치마크 'pinch' 추가 (POST /datasets) ===");
  const pinch = {
    id: "pinch-building-dashboards",
    version: "1.0.0",
    description:
      "PinchBench(github.com/pinchbench/skill) building-dashboards — LLM 코딩 에이전트가 Axiom 대시보드를 설계/구축.",
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

  // ── ② 유저의 hermes-desktop 하니스 등록 ──
  console.log("\n=== ② 유저가 hermes-desktop 하니스 등록 (POST /harnesses) ===");
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

  // ── ③ hermes-적합 벤치마크 추가 + 측정 ──
  console.log("\n=== ③ hermes-적합 벤치마크(SSH 연결) 추가 + hermes-desktop 으로 측정 ===");
  const hermesBench = {
    id: "hermes-ssh-bench",
    version: "1.0.0",
    description:
      "hermes-desktop os-use 벤치마크 — SSH 서버에 연결(에이전트가 SSH 폼을 실 OS 입력으로 채워 hermes 가 터널 오픈).",
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
  if (!scId) throw new Error("scorecard id 없음");

  // ── ④ 폴링 ──
  console.log("\n=== ④ 스코어카드 폴링 (hermes os-use 실행 중 — Electron+VLM judge, 수 분) ===");
  let rec;
  for (let i = 0; i < 120; i++) {
    await sleep(3000);
    const r = await fetch(`${BASE}/scorecards/${scId}`, { headers: H });
    rec = await r.json();
    process.stdout.write(`  status=${rec.status}\r`);
    if (rec.status === "succeeded" || rec.status === "failed") break;
  }
  console.log(`\n  최종 status: ${rec.status}`);
  if (rec.summary) console.log("  집계:", JSON.stringify(rec.summary));
  const cases = rec.scorecard?.results ?? [];
  for (const c of cases) {
    const j = c.scores?.find((s) => s.metric === "judge");
    console.log(
      `  케이스 ${c.caseId}: judge=${j?.pass ? "PASS" : "FAIL"} (${j?.value}) — ${String(j?.detail ?? "").slice(0, 120)}`,
    );
  }

  ok = r1.status === 201 && r2.status === 201 && r3.status === 201 && r4.status === 202 && rec.status === "succeeded";
  console.log(
    ok
      ? "\n✅ self-serve e2e: 유저가 HTTP API 만으로 ① 외부 벤치마크(pinch) 추가 → ② hermes-desktop 하니스 등록 → " +
          "③ hermes-적합 벤치마크 추가 + 측정(컨트롤플레인이 docker 런타임으로 hermes 이미지를 띄워 실 os-use 실행 + VLM judge) → " +
          "④ Scorecard 수신. 플랫폼이 벤치마크/하니스-비종속 self-serve 측정을 제공함을 입증."
      : "\n⚠️ 기대와 불일치(위 상태/응답 참고)",
  );
} catch (e) {
  console.error("error:", e instanceof Error ? e.message : e);
} finally {
  shutdown();
  spawnSync("docker", ["ps", "-aq", "--filter", "ancestor=everdict-hermes-dispatch:demo"], { encoding: "utf8" });
  console.log("control plane 종료.");
}
process.exit(ok ? 0 : 1);
