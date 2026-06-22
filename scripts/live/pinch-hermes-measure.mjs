// 라이브 e2e: hermes-desktop 하니스가 *pinch(PinchBench) 벤치마크* 태스크를 얼마나 수행하는지 측정 + 이력 기록.
// ① 컨트롤플레인(dev) 기동 → POST /datasets(pinch 벤치마크 추가) + POST /harnesses(hermes-desktop 등록)
// ② PinchBench core task_*.md 를 github 에서 받아 instruction(+workspace_files) 추출
// ③ 각 태스크를 hermes(assay-hermes-agent:demo, provider=LiteLLM)로 `hermes -z` 실행 → 답 캡처
// ④ LiteLLM judge 로 채점(태스크 충족 여부 pass + score)
// ⑤ POST /scorecards/ingest → Scorecard 레코드로 *이력* 기록(벤치마크 dataset id/ver + 하니스 id/ver + 점수 + 트레이스의
//    모델 llm_call). ⑥ GET /scorecards/:id 로 기록된 이력(하니스·모델·성능·벤치마크) 출력.
// 사전: assay-hermes-agent:demo 빌드됨, LiteLLM(:4000), apps/api/dist.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const CP_PORT = process.env.CP_PORT ?? "8789";
const BASE = `http://127.0.0.1:${CP_PORT}`;
const H = { "content-type": "application/json", "x-assay-tenant": "default" };
const AGENT_MODEL = process.env.HERMES_MODEL ?? "gpt-5.4-mini";
const JUDGE_MODEL = process.env.ASSAY_JUDGE_MODEL ?? "gpt-5.4-mini";
const LLM_BASE = "http://localhost:4000/v1";
const TASK_IDS = (process.env.PINCH_TASKS ?? "task_email,task_summary,task_commit_message_writer").split(",");
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
const post = async (p, b) => {
  const r = await fetch(`${BASE}${p}`, { method: "POST", headers: H, body: JSON.stringify(b) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const llm = async (model, messages) => {
  const r = await fetch(`${LLM_BASE}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages }),
  });
  const j = await r.json();
  return j.choices?.[0]?.message?.content ?? "";
};

// PinchBench task_*.md → {id, instruction(+workspace_files inlined), grading_type}
async function fetchTask(id) {
  const url = `https://raw.githubusercontent.com/pinchbench/skill/main/tasks/${id}.md`;
  const md = await (await fetch(url)).text();
  const fm = md.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const front = fm ? fm[1] : "";
  const body = (fm ? fm[2] : md).trim();
  const grading = (front.match(/grading_type:\s*(\S+)/) || [])[1] ?? "llm_judge";
  // workspace_files 블록의 content 를 프롬프트에 인라인(있으면)
  const files = [];
  if (front.includes("workspace_files:")) {
    for (const m of front.matchAll(/path:\s*"([^"]+)"\n\s*content:\s*\|\n([\s\S]*?)(?=\n\s*- path:|\n\w+:|$)/g)) {
      files.push(`# file: ${m[1]}\n${m[2].replace(/^ {6}/gm, "")}`);
    }
  }
  const prompt = files.length ? `${body}\n\n--- workspace files ---\n${files.join("\n\n")}` : body;
  return { id, instruction: body.slice(0, 400), prompt, grading };
}

console.log("=== 컨트롤플레인 기동(dev) ===");
const cp = spawn("node", ["apps/api/dist/main.js"], {
  cwd: new URL("../..", import.meta.url).pathname,
  env: {
    ...process.env,
    PORT: CP_PORT,
    OPENAI_API_KEY: KEY,
    OPENAI_BASE_URL: LLM_BASE,
    ASSAY_JUDGE_MODEL: JUDGE_MODEL,
    ASSAY_REQUIRE_AUTH: "",
    KEYCLOAK_ISSUER: "",
    DATABASE_URL: "",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
cp.stderr.on("data", (d) => /assay-api on/.test(String(d)) && process.stdout.write("  [cp] up\n"));
const shutdown = () => {
  try {
    cp.kill("SIGKILL");
  } catch {}
};

let ok = false;
try {
  for (
    let i = 0;
    i < 40 &&
    !(await fetch(`${BASE}/datasets`, { headers: H })
      .then((r) => r.status === 200)
      .catch(() => false));
    i++
  )
    await sleep(1000);

  console.log(`\n=== ② PinchBench core 태스크 ${TASK_IDS.length}개 로드 ===`);
  const tasks = [];
  for (const id of TASK_IDS) {
    try {
      const t = await fetchTask(id);
      tasks.push(t);
      console.log(`  ${id} [${t.grading}]: ${t.instruction.split("\n").find((l) => l.trim()) ?? ""}`);
    } catch (e) {
      console.log(`  ${id}: fetch fail ${e instanceof Error ? e.message : e}`);
    }
  }

  // ① pinch 벤치마크 등록(dataset) + hermes-desktop 하니스 등록
  console.log("\n=== ① pinch 벤치마크 + hermes-desktop 하니스 등록 ===");
  const ds = {
    id: "pinch-core",
    version: "1.0.0",
    description: "PinchBench (github.com/pinchbench/skill) — core 태스크 subset. LLM 에이전트 수행 능력 평가.",
    tags: ["pinchbench", "external", "agent"],
    cases: tasks.map((t) => ({
      id: t.id,
      env: { kind: "prompt" },
      task: t.instruction,
      graders: [{ id: "judge", config: { rubric: "PASS if the agent fully completed the task." } }],
      timeoutSec: 300,
      tags: ["pinchbench"],
    })),
  };
  console.log("  POST /datasets:", (await post("/datasets", ds)).status);
  console.log(
    "  POST /harnesses:",
    (
      await post("/harnesses", {
        kind: "command",
        id: "hermes-desktop",
        version: "1.0.0",
        workDir: "/tmp",
        env: {},
        setup: [],
        command: "hermes -z {{task}} --yolo",
        trace: { kind: "none" },
      })
    ).status,
  );

  // ③④ 각 태스크 hermes 실행 + judge 채점
  console.log(`\n=== ③④ hermes(${AGENT_MODEL}) 실행 + judge(${JUDGE_MODEL}) 채점 ===`);
  const traces = [];
  for (const t of tasks) {
    let answer = "";
    try {
      answer = execFileSync(
        "docker",
        [
          "run",
          "--rm",
          "--network=host",
          "-e",
          `HERMES_API_KEY=${KEY}`,
          "-e",
          `HERMES_BASE_URL=${LLM_BASE}`,
          "-e",
          `HERMES_MODEL=${AGENT_MODEL}`,
          "assay-hermes-agent:demo",
          "timeout",
          "200",
          "hermes",
          "-z",
          t.prompt,
          "--yolo",
        ],
        { encoding: "utf8", timeout: 240000, maxBuffer: 10 * 1024 * 1024 },
      ).trim();
    } catch (e) {
      answer = `(hermes error: ${e instanceof Error ? e.message.slice(0, 100) : e})`;
    }
    const verdict = await llm(JUDGE_MODEL, [
      {
        role: "system",
        content:
          'You grade whether an agent\'s answer completes a task. Reply with a JSON object: {"pass": true|false, "score": 0..1, "reason": "..."}. Be strict.',
      },
      { role: "user", content: `TASK:\n${t.instruction}\n\nAGENT ANSWER:\n${answer.slice(0, 2000)}` },
    ]);
    let v = { pass: false, score: 0, reason: "parse fail" };
    try {
      v = JSON.parse(verdict.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    } catch {}
    console.log(
      `  ${t.id}: judge=${v.pass ? "PASS" : "FAIL"} (${v.score}) ans="${answer.replace(/\s+/g, " ").slice(0, 70)}"`,
    );
    traces.push({
      caseId: t.id,
      trace: [
        { t: 0, kind: "llm_call", model: AGENT_MODEL, cost: { inputTokens: 0, outputTokens: 0, usd: 0 }, latencyMs: 0 },
        { t: 1, kind: "message", role: "assistant", text: answer.slice(0, 2000) },
      ],
      snapshot: { kind: "prompt", output: answer.slice(0, 2000) },
      scores: [
        {
          graderId: "judge",
          metric: "judge",
          value: Number(v.score) || 0,
          pass: !!v.pass,
          detail: `[judge=${JUDGE_MODEL}] ${String(v.reason).slice(0, 160)}`,
        },
      ],
    });
  }

  // ⑤ ingest → 이력 기록
  console.log("\n=== ⑤ POST /scorecards/ingest (이력 기록) ===");
  const ing = await post("/scorecards/ingest", {
    dataset: { id: "pinch-core", version: "1.0.0" },
    harness: { id: "hermes-desktop", version: "1.0.0" },
    traces,
  });
  console.log(`  → ${ing.status} id=${ing.json.id}`);
  const scId = ing.json.id;

  // ⑥ 기록된 이력 출력
  let rec;
  for (let i = 0; i < 40; i++) {
    await sleep(1500);
    rec = await (await fetch(`${BASE}/scorecards/${scId}`, { headers: H })).json();
    if (rec.status === "succeeded" || rec.status === "failed") break;
  }
  console.log(`\n================ 기록된 평가 이력 (GET /scorecards/${scId.slice(0, 8)}…) ================`);
  console.log(`  벤치마크(dataset): ${rec.dataset?.id}@${rec.dataset?.version}`);
  console.log(`  하니스(harness)  : ${rec.harness?.id}@${rec.harness?.version}`);
  console.log(`  상태/시각        : ${rec.status} · ${rec.createdAt}`);
  console.log(`  성능(집계)       : ${JSON.stringify(rec.summary)}`);
  for (const r of rec.scorecard?.results ?? []) {
    const j = r.scores?.find((s) => s.metric === "judge");
    const m = r.trace?.find((e) => e.kind === "llm_call");
    console.log(`   - ${r.caseId}: judge=${j?.pass ? "PASS" : "FAIL"}(${j?.value}) | 모델(trace)=${m?.model}`);
  }
  const j = (rec.summary ?? []).find((m) => m.metric === "judge");
  console.log(
    `\n  → pinch 수행도: judge passRate=${((j?.passRate ?? 0) * 100) | 0}% (n=${j?.count ?? 0}), agent 모델=${AGENT_MODEL}, judge 모델=${JUDGE_MODEL}`,
  );
  ok = ing.status === 202 && rec.status === "succeeded";
  console.log(
    ok
      ? "\n✅ hermes-desktop 의 pinch 수행도를 측정하고, 벤치마크/하니스 id+버전/모델/성능을 Scorecard 이력으로 기록함."
      : "\n⚠️ 기대와 불일치",
  );
} catch (e) {
  console.error("error:", e instanceof Error ? e.stack : e);
} finally {
  shutdown();
  console.log("control plane 종료.");
}
process.exit(ok ? 0 : 1);
