// Live e2e: measure hermes-desktop's performance on the **entire PinchBench core (~21 tasks)** *faithfully per grading type* + record history.
// Grading uses PinchBench's native approach: automated/hybrid → run the task .md's `## Automated Checks` grade(transcript, workspace_path)
// function as-is (pinch-grade.py, network-less python container); llm_judge/hybrid → grade the output files with the task's rubric.
//   automated: score=grade().mean | llm_judge: score=judge | hybrid: score=avg(grade().mean, judge)
// Flow (per task): mkdtemp workspace + seed inputs → hermes -z (CWD=/work, --network=host) → collect output files/transcript
//   → run automated grade() → (if needed) rubric judge → combine → POST /scorecards/ingest → print GET history.
// Prerequisites: everdict-hermes-agent:demo, LiteLLM (:4000), apps/api/dist, python:3.12-slim (auto pull), alpine.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";

const CP_PORT = process.env.CP_PORT ?? "8791";
const BASE = `http://127.0.0.1:${CP_PORT}`;
const H = { "content-type": "application/json", "x-everdict-tenant": "default" };
const AGENT_MODEL = process.env.HERMES_MODEL ?? "gpt-5.4-mini";
const JUDGE_MODEL = process.env.EVERDICT_JUDGE_MODEL ?? "gpt-5.4-mini";
const LLM_BASE = "http://localhost:4000/v1";
const SCRIPTS = new URL(".", import.meta.url).pathname; // scripts/live (location of pinch-grade.py)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// PinchBench manifest core list (~21) + categories.
const CORE = [
  ["task_sanity", "productivity"],
  ["task_calendar", "productivity"],
  ["task_stock", "research"],
  ["task_market_research", "research"],
  ["task_email", "writing"],
  ["task_humanizer", "writing"],
  ["task_weather", "coding"],
  ["task_shell_command_generator", "coding"],
  ["task_multi_file_refactoring", "coding"],
  ["task_summary", "analysis"],
  ["task_spreadsheet_summary", "analysis"],
  ["task_csv_stock_trend", "csv_analysis"],
  ["task_csv_iris_summary", "csv_analysis"],
  ["task_log_apache_top_errors", "log_analysis"],
  ["task_log_syslog_boot", "log_analysis"],
  ["task_meeting_tldr", "meeting_analysis"],
  ["task_meeting_council_votes", "meeting_analysis"],
  ["task_memory", "memory"],
  ["task_files", "skills"],
  ["task_skill_search", "skills"],
  ["task_gws_email_triage", "integrations"],
];
const TASK_IDS = process.env.PINCH_TASKS ? process.env.PINCH_TASKS.split(",").map((id) => [id, "?"]) : CORE;

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
  return (await r.json()).choices?.[0]?.message?.content ?? "";
};

// task_*.md → {id, category, grading, prompt, rubric, inputs:[{path,content}], md(full), timeout}
async function fetchTask([id, category]) {
  const md = await (await fetch(`https://raw.githubusercontent.com/pinchbench/skill/main/tasks/${id}.md`)).text();
  const fm = md.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const front = fm ? fm[1] : "";
  const body = fm ? fm[2] : md;
  const grading = (front.match(/grading_type:\s*(\S+)/) || [])[1] ?? "llm_judge";
  const timeout = Math.min(Number((front.match(/timeout_seconds:\s*(\d+)/) || [])[1]) || 180, 240);
  const section = (name) => {
    const m = body.match(new RegExp(`##+\\s*${name}[\\s\\S]*?(?=\\n##\\s|$)`, "i"));
    return m ? m[0].trim() : "";
  };
  const prompt = (section("Prompt") || body.slice(0, 600)).replace(/^##+\s*Prompt\s*/i, "").trim();
  const rubric =
    `${section("Grading Criteria")}\n\n${section("LLM Judge Rubric")}`.trim() ||
    "Grade if the task is fully and correctly completed.";
  // workspace_files: supports both source/dest (references repo assets/<source>, incl. binaries) and path/content (inline).
  const inputs = [];
  const wfm = front.match(/workspace_files:\s*\n([\s\S]*?)(?=\n[a-z_]+:\s|$)/i);
  if (wfm?.[1].includes("-")) {
    const items = wfm[1]
      .split(/\n(?=\s*-\s)/)
      .map((s) => s.replace(/^\s*-\s+/, ""))
      .filter(Boolean);
    for (const it of items) {
      const src = (it.match(/source:\s*"?([^"\n]+?)"?\s*$/m) || [])[1]?.trim();
      const dest = (it.match(/dest:\s*"?([^"\n]+?)"?\s*$/m) || [])[1]?.trim();
      const path = (it.match(/path:\s*"?([^"\n]+?)"?\s*$/m) || [])[1]?.trim();
      if (src && dest) {
        try {
          const ab = await (
            await fetch(`https://raw.githubusercontent.com/pinchbench/skill/main/assets/${src}`)
          ).arrayBuffer();
          inputs.push({ dest, buf: Buffer.from(ab) });
        } catch {}
      } else if (path) {
        const cm = it.match(/content:\s*\|\s*\n([\s\S]*)$/);
        inputs.push({ dest: path, buf: Buffer.from(cm ? cm[1].replace(/^ {6}/gm, "") : "") });
      }
    }
  }
  // hybrid combination weights (task-specified grading_weights, default 0.5/0.5)
  const wm = front.match(/grading_weights:\s*\n\s*automated:\s*([\d.]+)\s*\n\s*llm_judge:\s*([\d.]+)/);
  const weights = wm ? { auto: Number(wm[1]), judge: Number(wm[2]) } : { auto: 0.5, judge: 0.5 };
  return { id, category, grading, prompt, rubric, inputs, md, timeout, weights };
}

// Run hermes in the workspace (/work) → collect output files (excluding inputs/hidden).
function runHermes(t) {
  const ws = mkdtempSync(join(tmpdir(), "pinch-ws-"));
  for (const f of t.inputs) {
    const p = join(ws, f.dest);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.buf);
  }
  const inputNames = new Set(t.inputs.map((f) => f.dest));
  let chat = "";
  try {
    chat = execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "--network=host",
        "-v",
        `${ws}:/work`,
        "-w",
        "/work",
        "-e",
        `HERMES_API_KEY=${KEY}`,
        "-e",
        `HERMES_BASE_URL=${LLM_BASE}`,
        "-e",
        `HERMES_MODEL=${AGENT_MODEL}`,
        "everdict-hermes-agent:demo",
        "timeout",
        String(t.timeout),
        "hermes",
        "-z",
        t.prompt,
        "--yolo",
      ],
      { encoding: "utf8", timeout: (t.timeout + 40) * 1000, maxBuffer: 16 * 1024 * 1024 },
    ).trim();
  } catch (e) {
    chat = `(hermes error: ${e instanceof Error ? e.message.slice(0, 120) : e})`;
  }
  let dump = "";
  try {
    dump = execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "-v",
        `${ws}:/work`,
        "alpine",
        "sh",
        "-c",
        'cd /work && for f in $(find . -maxdepth 2 -type f 2>/dev/null); do printf "<<<F:%s>>>\\n" "$f" && cat "$f"; done',
      ],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
  } catch {}
  const files = [];
  const parts = dump.split(/<<<F:(.+?)>>>\n/);
  for (let i = 1; i < parts.length; i += 2) {
    const name = parts[i].replace(/^\.\//, "");
    if (!inputNames.has(name) && !name.startsWith(".")) files.push({ name, content: (parts[i + 1] ?? "").trim() });
  }
  return { chat, files, ws };
}

// Run the task .md's grade(transcript, workspace_path) (network-less python container).
function gradeAutomated(t, ws, chat) {
  const gdir = mkdtempSync(join(tmpdir(), "pinch-grade-"));
  writeFileSync(join(gdir, "task.md"), t.md);
  writeFileSync(
    join(gdir, "transcript.json"),
    JSON.stringify([
      { type: "message", message: { role: "user", content: [{ type: "text", text: t.prompt }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: chat }] } },
    ]),
  );
  try {
    const out = execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        "-v",
        `${ws}:/work`,
        "-v",
        `${gdir}:/grade`,
        "-v",
        `${SCRIPTS}:/scripts:ro`,
        "python:3.12-slim",
        "python",
        "/scripts/pinch-grade.py",
        "/grade/task.md",
        "/work",
        "/grade/transcript.json",
      ],
      { encoding: "utf8", timeout: 90000, maxBuffer: 8 * 1024 * 1024 },
    );
    return JSON.parse(out.trim().split("\n").pop());
  } catch (e) {
    return { error: `grader: ${e instanceof Error ? e.message.slice(0, 120) : e}` };
  }
}

async function gradeJudge(t, files) {
  const outDump = files.length
    ? files.map((f) => `### ${f.name}\n${f.content.slice(0, 2500)}`).join("\n\n")
    : "(no output file produced)";
  const verdict = await llm(JUDGE_MODEL, [
    {
      role: "system",
      content:
        'Strict grader. Apply the task rubric to the AGENT OUTPUT FILE(S). Reply JSON {"score":0..1,"reason":"..."}.',
    },
    {
      role: "user",
      content: `TASK:\n${t.prompt}\n\nRUBRIC:\n${t.rubric.slice(0, 2800)}\n\nOUTPUT FILE(S):\n${outDump.slice(0, 4000)}`,
    },
  ]);
  try {
    const v = JSON.parse(verdict.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    return { score: Number(v.score) || 0, reason: String(v.reason ?? "").slice(0, 200) };
  } catch {
    return { score: 0, reason: "judge parse fail" };
  }
}

console.log("=== start control plane (dev) ===");
const cp = spawn("node", ["apps/api/dist/main.js"], {
  cwd: new URL("../..", import.meta.url).pathname,
  env: {
    ...process.env,
    PORT: CP_PORT,
    OPENAI_API_KEY: KEY,
    OPENAI_BASE_URL: LLM_BASE,
    EVERDICT_JUDGE_MODEL: JUDGE_MODEL,
    EVERDICT_REQUIRE_AUTH: "",
    KEYCLOAK_ISSUER: "",
    DATABASE_URL: "",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
cp.stderr.on("data", (d) => /everdict-api on/.test(String(d)) && process.stdout.write("  [cp] up\n"));
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
  // Pre-pull python:3.12-slim (avoid first-grade delay)
  try {
    execFileSync("docker", ["pull", "-q", "python:3.12-slim"], { stdio: "ignore", timeout: 120000 });
  } catch {}

  console.log(`\n=== load ${TASK_IDS.length} PinchBench core tasks ===`);
  const tasks = [];
  for (const pair of TASK_IDS) {
    try {
      const t = await fetchTask(pair);
      tasks.push(t);
    } catch (e) {
      console.log(`  ${pair[0]}: fetch fail ${e instanceof Error ? e.message : e}`);
    }
  }
  const byType = {};
  for (const t of tasks) byType[t.grading] = (byType[t.grading] || 0) + 1;
  const seeded = tasks.filter((t) => t.inputs.length).length;
  console.log(
    `  loaded ${tasks.length} — grading types: ${JSON.stringify(byType)} — tasks with seeded input files: ${seeded}`,
  );

  console.log("\n=== register pinch core benchmark + hermes-desktop harness ===");
  await post("/datasets", {
    id: "pinch-core-21",
    version: "1.0.0",
    description:
      "PinchBench core (~21) — faithful grading per grading type (automated=run task grade(), llm_judge=rubric, hybrid=both).",
    tags: ["pinchbench", "core", "faithful"],
    cases: tasks.map((t) => ({
      id: t.id,
      env: { kind: "prompt" },
      task: t.prompt.slice(0, 160),
      graders: [{ id: t.grading, config: { category: t.category } }],
      timeoutSec: 300,
      tags: ["pinchbench", t.category, t.grading],
    })),
  });
  await post("/harnesses", {
    kind: "command",
    id: "hermes-desktop",
    version: "1.0.0",
    workDir: "/work",
    env: {},
    setup: [],
    command: "hermes -z {{task}} --yolo",
    trace: { kind: "none" },
  });

  console.log(`\n=== run hermes(${AGENT_MODEL}) + grade per grading type (${tasks.length} tasks, tens of minutes) ===`);
  const traces = [];
  let n = 0;
  for (const t of tasks) {
    n++;
    const { chat, files, ws } = runHermes(t);
    let auto = null;
    let judge = null;
    if (t.grading === "automated" || t.grading === "hybrid") auto = gradeAutomated(t, ws, chat);
    if (t.grading === "llm_judge" || t.grading === "hybrid") judge = await gradeJudge(t, files);
    const autoMean = auto && typeof auto.mean === "number" ? auto.mean : null;
    let score = 0;
    if (t.grading === "automated") score = autoMean ?? 0;
    else if (t.grading === "llm_judge") score = judge?.score ?? 0;
    // hybrid: combine using task-specified weights (grading_weights)
    else
      score =
        autoMean != null && judge
          ? t.weights.auto * autoMean + t.weights.judge * judge.score
          : (autoMean ?? judge?.score ?? 0);
    const pass = score >= 0.6;
    const detail =
      `[${t.grading}] ${auto ? (auto.error ? `auto:ERR(${auto.error})` : `auto:${autoMean?.toFixed(2)}`) : ""}${judge ? ` judge:${judge.score}(${judge.reason.slice(0, 60)})` : ""}`.trim();
    console.log(
      `  [${n}/${tasks.length}] ${t.id} (${t.category}/${t.grading}): score=${score.toFixed(2)} ${pass ? "PASS" : "FAIL"} in=${t.inputs.length} files=[${files.map((f) => f.name).join(",")}] ${detail.slice(0, 100)}`,
    );
    traces.push({
      caseId: t.id,
      trace: [
        { t: 0, kind: "llm_call", model: AGENT_MODEL, cost: { inputTokens: 0, outputTokens: 0, usd: 0 }, latencyMs: 0 },
        {
          t: 1,
          kind: "message",
          role: "assistant",
          text: `[${t.grading}] files: ${files.map((f) => f.name).join(", ") || "(none)"}`,
        },
      ],
      snapshot: {
        kind: "prompt",
        output: (files.map((f) => `### ${f.name}\n${f.content}`).join("\n\n") || chat).slice(0, 2000),
      },
      scores: [
        { graderId: t.grading, metric: "score", value: score, pass, detail: detail.slice(0, 240) },
        ...(autoMean != null
          ? [
              {
                graderId: "automated",
                metric: "automated",
                value: autoMean,
                pass: autoMean >= 0.6,
                detail: JSON.stringify(auto.scores ?? auto).slice(0, 200),
              },
            ]
          : []),
        ...(judge
          ? [
              {
                graderId: "judge",
                metric: "judge",
                value: judge.score,
                pass: judge.score >= 0.6,
                detail: `[judge=${JUDGE_MODEL}] ${judge.reason}`,
              },
            ]
          : []),
      ],
    });
  }

  console.log("\n=== POST /scorecards/ingest (record history) ===");
  const ing = await post("/scorecards/ingest", {
    dataset: { id: "pinch-core-21", version: "1.0.0" },
    harness: { id: "hermes-desktop", version: "1.0.0" },
    traces,
  });
  const scId = ing.json.id;
  console.log(`  → ${ing.status} id=${scId}`);

  let rec;
  for (let i = 0; i < 40; i++) {
    await sleep(1500);
    rec = await (await fetch(`${BASE}/scorecards/${scId}`, { headers: H })).json();
    if (rec.status === "succeeded" || rec.status === "failed") break;
  }
  console.log(
    `\n================ recorded evaluation history (PinchBench core, GET /scorecards/${String(scId).slice(0, 8)}…) ================`,
  );
  console.log(
    `  benchmark: ${rec.dataset?.id}@${rec.dataset?.version} | harness: ${rec.harness?.id}@${rec.harness?.version} | ${rec.status}`,
  );
  const results = rec.scorecard?.results ?? [];
  const cat = {};
  for (const t of tasks) {
    const r = results.find((x) => x.caseId === t.id);
    const s = r?.scores?.find((x) => x.metric === "score");
    if (!cat[t.category]) cat[t.category] = [];
    cat[t.category].push(s?.value ?? 0);
    console.log(
      `   - ${t.id} (${t.category}/${t.grading}): ${((s?.value ?? 0) * 100) | 0}% ${s?.pass ? "PASS" : "FAIL"}`,
    );
  }
  console.log("\n  average per category:");
  for (const [c, arr] of Object.entries(cat))
    console.log(`   ${c}: ${((arr.reduce((a, b) => a + b, 0) / arr.length) * 100) | 0}% (n=${arr.length})`);
  const all = results.map((r) => r.scores?.find((x) => x.metric === "score")?.value ?? 0);
  const passN = all.filter((v) => v >= 0.6).length;
  console.log(
    `\n  → PinchBench core performance: passRate ${((passN / all.length) * 100) | 0}% (${passN}/${all.length}), mean ${((all.reduce((a, b) => a + b, 0) / all.length) * 100) | 0}% (agent=${AGENT_MODEL})`,
  );
  ok = ing.status === 202 && rec.status === "succeeded";
  console.log(
    ok
      ? "\n✅ measured the entire PinchBench core faithfully per grading type → recorded history."
      : "\n⚠️ does not match expectation",
  );
} catch (e) {
  console.error("error:", e instanceof Error ? e.stack : e);
} finally {
  shutdown();
  console.log("control plane shut down.");
}
process.exit(ok ? 0 : 1);
