// 라이브 e2e: *데스크탑 + 웹 통합 리포트* — 하니스-비종속 입증. 같은 assay 채점/스코어카드 흐름으로 두 트랙을 한 리포트에:
//   • 데스크탑(os-use/OSWorld): runAgentJob(command 하니스 + OsUseEnvironment) → mousepad 로 파일 생성 → VLM judge(스크린샷)
//     + command/state grader(verify 로 실제 파일 검증).  [packages/agent runAgentJob + DockerDriver]
//   • 웹(browser-use/WebVoyager): ServiceTopologyBackend(service 하니스) → 실 사이트 구동 → answer-match + judge.
// 두 트랙의 CaseResult 를 각각 Scorecard 로 모아 summarizeScorecard + 통합 요약(트랙별 + 전체 통과율)을 출력.
//
// 사전: docker. 이미지(assay-osworld:demo / assay-browseruse:demo)는 이 스크립트가 없으면 빌드. Jaeger/LiteLLM 가동.
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, readFileSync } from "node:fs";
import process from "node:process";
import { runAgentJob } from "../../packages/agent/dist/index.js";
import { importWebVoyager } from "../../packages/datasets/dist/index.js";
import { DockerDriver } from "../../packages/drivers/dist/index.js";
import { summarizeScorecard } from "../../packages/suite/dist/index.js";
import { ServiceTopologyBackend } from "../../packages/topology/dist/index.js";
import { OtelTraceSource } from "../../packages/trace/dist/index.js";

const OSWORLD_IMAGE = "assay-osworld:demo";
const BU_IMAGE = "assay-browseruse:demo";
const PORT = "18080";
const JAEGER_QUERY = "http://localhost:16686";
const NAME = "assay-unified-bu";
const FRONT = `http://127.0.0.1:${PORT}`;
const here = (p) => new URL(p, import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function masterKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  try {
    const t = readFileSync(here("../../../../infra/litellm/.env"), "utf8");
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
process.env.OPENAI_API_KEY = KEY;
process.env.OPENAI_BASE_URL = process.env.OPENAI_BASE_URL ?? "http://localhost:4000/v1";
process.env.ASSAY_JUDGE_MODEL = process.env.ASSAY_JUDGE_MODEL ?? "gpt-5.4-mini";
process.env.ASSAY_JUDGE_PROVIDER = "openai";
const JUDGE = { provider: "openai", model: process.env.ASSAY_JUDGE_MODEL };

function ensureImage(image, build) {
  const have = spawnSync("docker", ["image", "inspect", image], { stdio: "ignore" }).status === 0;
  if (!have) {
    console.log(`build ${image} …`);
    build();
  }
}

// ───────── 데스크탑 트랙 (os-use / OSWorld) ─────────
async function desktopTrack() {
  ensureImage(OSWORLD_IMAGE, () => {
    copyFileSync(here("../../examples/agents/desktop-osworld-agent.cjs"), here("desktop-osworld-agent.cjs.ctx"));
    // 빌드 컨텍스트에 agent-osworld.cjs 로 복사 필요 → 임시로 scripts/live 에 두고 build.
    execFileSync("cp", [
      here("../../examples/agents/desktop-osworld-agent.cjs").pathname,
      here("agent-osworld.cjs").pathname,
    ]);
    execFileSync(
      "docker",
      ["build", "-q", "-f", here("Dockerfile.osworld").pathname, "-t", OSWORLD_IMAGE, here(".").pathname],
      { stdio: "ignore" },
    );
    spawnSync("rm", ["-f", here("agent-osworld.cjs").pathname, here("desktop-osworld-agent.cjs.ctx").pathname]);
  });
  const rows = readFileSync(here("../../examples/benchmarks/osworld-sample.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .slice(0, 1); // 1 케이스(데모; 데스크탑 자동화는 무거움)
  const results = [];
  for (const row of rows) {
    const job = {
      harness: { id: "desktop-osworld", version: "1.0.0" },
      harnessSpec: {
        kind: "command",
        id: "desktop-osworld",
        version: "1.0.0",
        workDir: "/tmp",
        env: { DISPLAY: ":99" },
        setup: [],
        command: "node /agent-osworld.cjs {{task}}",
        trace: { kind: "none" },
      },
      evalCase: {
        id: row.id,
        env: {
          kind: "os-use",
          display: ":99",
          setup: [
            "Xvfb :99 -screen 0 1280x900x24 >/tmp/xvfb.log 2>&1 & sleep 2",
            "DISPLAY=:99 openbox >/tmp/openbox.log 2>&1 & sleep 1",
          ],
          screenshotPath: "/tmp/osuse.png",
        },
        image: OSWORLD_IMAGE,
        task: row.instruction,
        graders: [
          {
            id: "judge",
            config: {
              useScreenshot: true,
              rubric: `Judge the final DESKTOP screenshot. PASS only if it clearly shows this task completed: "${row.instruction}".`,
            },
          },
          ...(row.verify ? [{ id: "command", config: { cmd: row.verify, cwd: "/tmp", metric: "state" } }] : []),
        ],
        timeoutSec: 300,
        tags: ["os-use", "osworld"],
      },
      judge: JUDGE,
    };
    console.log(`  [desktop] ${row.id}: ${row.instruction.slice(0, 60)}…`);
    try {
      const r = await runAgentJob(job, { driver: new DockerDriver() });
      const j = r.scores.find((s) => s.metric === "judge");
      const st = r.scores.find((s) => s.metric === "state");
      console.log(`    judge=${j?.pass ? "PASS" : "FAIL"} state=${st ? (st.pass ? "PASS" : "FAIL") : "-"}`);
      results.push(r);
    } catch (e) {
      console.log(`    error ${e instanceof Error ? e.message : e}`);
    }
  }
  return { suiteId: "osworld-sample", harness: "desktop-osworld@1.0.0", results };
}

// ───────── 웹 트랙 (browser-use / WebVoyager) ─────────
async function webTrack() {
  ensureImage(BU_IMAGE, () => {
    execFileSync(
      "docker",
      ["build", "-q", "-t", BU_IMAGE, "-f", here("Dockerfile.browseruse").pathname, here(".").pathname],
      { stdio: "ignore" },
    );
  });
  const dataset = importWebVoyager(readFileSync(here("../../examples/benchmarks/webvoyager-sample.jsonl"), "utf8"), {
    id: "webvoyager-sample",
    version: "v1",
    source: "github:MinorJerry/WebVoyager",
  });
  const cases = dataset.cases.slice(0, 2);
  spawnSync("docker", ["rm", "-f", NAME], { stdio: "ignore" });
  execFileSync(
    "docker",
    [
      "run",
      "-d",
      "--name",
      NAME,
      "--network=host",
      "-e",
      `PORT=${PORT}`,
      "-e",
      `OPENAI_API_KEY=${KEY}`,
      "-e",
      "OPENAI_BASE_URL=http://localhost:4000/v1",
      "-e",
      "OTLP_URL=http://localhost:4318/v1/traces",
      "-e",
      "BROWSERUSE_MODEL=chatgpt/gpt-5.4",
      "-e",
      "BROWSERUSE_MAX_STEPS=12",
      BU_IMAGE,
    ],
    { stdio: "ignore" },
  );
  let healthy = false;
  for (let i = 0; i < 60 && !healthy; i++) {
    await sleep(2000);
    try {
      healthy = (await fetch(`${FRONT}/health`)).status === 200;
    } catch {}
  }
  const results = [];
  if (healthy) {
    const otel = new OtelTraceSource({ endpoint: JAEGER_QUERY });
    const backend = new ServiceTopologyBackend({
      runtime: {
        id: "local-docker",
        async ensureTopology() {
          return { endpoints: { agent: FRONT } };
        },
        async provisionBrowserEnv() {
          return {
            cdpUrl: "",
            async snapshot() {
              const j = await (await fetch(`${FRONT}/observe`)).json();
              return { kind: "browser", url: j.url || "", dom: j.dom || "", console: [] };
            },
            async dispose() {},
          };
        },
      },
      traceSource: {
        async fetch(runId) {
          for (let i = 0; i < 20; i++) {
            try {
              const ev = await otel.fetch(runId);
              if (ev.length > 0) return ev;
            } catch {}
            await sleep(1000);
          }
          return [];
        },
      },
      specFor: () => ({
        kind: "service",
        id: "browseruse",
        version: "webvoyager",
        services: [{ name: "agent", image: BU_IMAGE, port: Number(PORT), needs: [], perRun: [], replicas: 1 }],
        dependencies: [],
        frontDoor: { service: "agent", submit: "POST /runs" },
        traceSource: { kind: "otel", endpoint: JAEGER_QUERY },
      }),
      newRunId: () => randomUUID().replace(/-/g, ""),
    });
    for (const c of cases) {
      const task = c.env.startUrl ? `Go to ${c.env.startUrl} . ${c.task}` : c.task;
      console.log(`  [web] ${c.id}: ${c.task.slice(0, 50)}…`);
      try {
        const r = await backend.dispatch({
          tenant: "default",
          harness: { id: "browseruse", version: "webvoyager" },
          evalCase: { ...c, task, timeoutSec: 300 },
        });
        const am = r.scores.find((s) => s.metric === "answer_match");
        console.log(`    answer_match=${am?.pass ? "PASS" : "FAIL"}`);
        results.push(r);
      } catch (e) {
        console.log(`    error ${e instanceof Error ? e.message : e}`);
      }
    }
  } else {
    console.log("  [web] front-door health timeout — 웹 트랙 건너뜀");
  }
  spawnSync("docker", ["rm", "-f", NAME], { stdio: "ignore" });
  return { suiteId: "webvoyager-sample", harness: "browseruse@webvoyager", results };
}

function passRate(sc) {
  let pass = 0;
  let total = 0;
  for (const r of sc.results) {
    const ds = r.scores.filter((s) => s.pass !== undefined);
    if (!ds.length) continue;
    total++;
    if (ds.every((s) => s.pass)) pass++; // 케이스의 결정적 그레이더가 모두 pass 면 케이스 pass
  }
  return { pass, total };
}

let ok = false;
try {
  console.log("=== 통합 리포트: 데스크탑(OSWorld/os-use) + 웹(WebVoyager/browser-use) ===\n--- 데스크탑 트랙 ---");
  const desktop = await desktopTrack();
  console.log("\n--- 웹 트랙 ---");
  const web = await webTrack();

  console.log("\n================ UNIFIED REPORT ================");
  for (const [label, sc] of [
    ["DESKTOP (os-use/OSWorld)", desktop],
    ["WEB (browser-use/WebVoyager)", web],
  ]) {
    const pr = passRate(sc);
    console.log(`\n[${label}] harness=${sc.harness} — 케이스 ${sc.results.length}, pass ${pr.pass}/${pr.total}`);
    for (const m of summarizeScorecard(sc)) {
      const p = m.passRate !== undefined ? ` passRate=${(m.passRate * 100).toFixed(0)}%` : "";
      console.log(`   ${m.metric}: n=${m.count} mean=${m.mean.toFixed(4)}${p}`);
    }
  }
  const dpr = passRate(desktop);
  const wpr = passRate(web);
  const totPass = dpr.pass + wpr.pass;
  const totN = dpr.total + wpr.total;
  console.log(
    `\n[COMBINED] 데스크탑+웹 전체 case pass ${totPass}/${totN} (${totN ? ((totPass / totN) * 100).toFixed(0) : 0}%)`,
  );
  ok = desktop.results.length > 0 && web.results.length > 0;
  console.log(
    ok
      ? "\n✅ ③: 하나의 통합 리포트가 *데스크탑(os-use/OSWorld, runAgentJob)* 과 *웹(browser-use/WebVoyager, " +
          "ServiceTopologyBackend)* 두 트랙을 같은 assay CaseResult→Scorecard→summarize 흐름으로 묶음 — 하니스/인프라-비종속 " +
          "평가 런타임이 데스크탑+웹 벤치마크를 하나의 리포트로 산출."
      : "\n⚠️ 한 트랙 결과 없음(위 로그 참고)",
  );
} catch (e) {
  console.error("error:", e instanceof Error ? e.message : e);
} finally {
  spawnSync("docker", ["rm", "-f", NAME], { stdio: "ignore" });
}
process.exit(ok ? 0 : 1);
