// live e2e: *unified desktop + web report* — demonstrates harness-agnosticism. Two tracks in one report via the same everdict grading/scorecard flow:
//   • desktop (os-use/OSWorld): runAgentJob (command harness + OsUseEnvironment) → create a file with mousepad → VLM judge (screenshot)
//     + command/state grader (verify checks the actual file).  [packages/agent runAgentJob + DockerDriver]
//   • web (browser-use/WebVoyager): ServiceTopologyBackend (service harness) → drive a real site → answer-match + judge.
// Collect each track's CaseResults into a Scorecard and print summarizeScorecard + a unified summary (per-track + overall pass rate).
//
// Prereq: docker. The script builds the images (everdict-osworld:demo / everdict-browseruse:demo) if absent. Jaeger/LiteLLM running.
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, readFileSync } from "node:fs";
import process from "node:process";
import { runAgentJob } from "../../packages/agent/dist/index.js";
import { importWebVoyager } from "../../packages/datasets/dist/index.js";
import { DockerDriver } from "../../packages/drivers/dist/index.js";
import { scorecardPassRate, summarizeScorecard } from "../../packages/suite/dist/index.js";
import { ServiceTopologyBackend } from "../../packages/topology/dist/index.js";
import { OtelTraceSource } from "../../packages/trace/dist/index.js";

const OSWORLD_IMAGE = "everdict-osworld:demo";
const BU_IMAGE = "everdict-browseruse:demo";
const PORT = "18080";
const JAEGER_QUERY = "http://localhost:16686";
const NAME = "everdict-unified-bu";
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
  console.error("No LLM key.");
  process.exit(2);
}
process.env.OPENAI_API_KEY = KEY;
process.env.OPENAI_BASE_URL = process.env.OPENAI_BASE_URL ?? "http://localhost:4000/v1";
process.env.EVERDICT_JUDGE_MODEL = process.env.EVERDICT_JUDGE_MODEL ?? "gpt-5.4-mini";
process.env.EVERDICT_JUDGE_PROVIDER = "openai";
const JUDGE = { provider: "openai", model: process.env.EVERDICT_JUDGE_MODEL };

function ensureImage(image, build) {
  const have = spawnSync("docker", ["image", "inspect", image], { stdio: "ignore" }).status === 0;
  if (!have) {
    console.log(`build ${image} …`);
    build();
  }
}

// ───────── desktop track (os-use / OSWorld) ─────────
async function desktopTrack() {
  ensureImage(OSWORLD_IMAGE, () => {
    copyFileSync(here("../../examples/agents/desktop-osworld-agent.cjs"), here("desktop-osworld-agent.cjs.ctx"));
    // Needs to be copied to agent-osworld.cjs in the build context → temporarily place it in scripts/live and build.
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
    .slice(0, 1); // 1 case (demo; desktop automation is heavy)
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

// ───────── web track (browser-use / WebVoyager) ─────────
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
            wiring: { target_cdp_url: "" },
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
    console.log("  [web] front-door health timeout — skipping web track");
  }
  spawnSync("docker", ["rm", "-f", NAME], { stdio: "ignore" });
  return { suiteId: "webvoyager-sample", harness: "browseruse@webvoyager", results };
}

// Case pass rate is the authoritative measure (scorecardPassRate/caseVerdict) — ground-truth(state) > objective > judge. As with OSWorld file-save,
// if the state grader PASSes, the case PASSes even when the VLM judge FAILs.
let ok = false;
try {
  console.log("=== unified report: desktop(OSWorld/os-use) + web(WebVoyager/browser-use) ===\n--- desktop track ---");
  const desktop = await desktopTrack();
  console.log("\n--- web track ---");
  const web = await webTrack();

  console.log("\n================ UNIFIED REPORT ================");
  for (const [label, sc] of [
    ["DESKTOP (os-use/OSWorld)", desktop],
    ["WEB (browser-use/WebVoyager)", web],
  ]) {
    const pr = scorecardPassRate(sc);
    console.log(`\n[${label}] harness=${sc.harness} — cases ${sc.results.length}, pass ${pr.pass}/${pr.total}`);
    for (const m of summarizeScorecard(sc)) {
      const p = m.passRate !== undefined ? ` passRate=${(m.passRate * 100).toFixed(0)}%` : "";
      console.log(`   ${m.metric}: n=${m.count} mean=${m.mean.toFixed(4)}${p}`);
    }
  }
  const dpr = scorecardPassRate(desktop);
  const wpr = scorecardPassRate(web);
  const totPass = dpr.pass + wpr.pass;
  const totN = dpr.total + wpr.total;
  console.log(
    `\n[COMBINED] desktop+web overall case pass ${totPass}/${totN} (${totN ? ((totPass / totN) * 100).toFixed(0) : 0}%)`,
  );
  ok = desktop.results.length > 0 && web.results.length > 0;
  console.log(
    ok
      ? "\n✅ ③: one unified report ties both tracks — *desktop (os-use/OSWorld, runAgentJob)* and *web (browser-use/WebVoyager, " +
          "ServiceTopologyBackend)* — through the same everdict CaseResult→Scorecard→summarize flow — a harness/infra-agnostic " +
          "eval runtime produces desktop+web benchmarks in a single report."
      : "\n⚠️ one track has no results (see logs above)",
  );
} catch (e) {
  console.error("error:", e instanceof Error ? e.message : e);
} finally {
  spawnSync("docker", ["rm", "-f", NAME], { stdio: "ignore" });
}
process.exit(ok ? 0 : 1);
