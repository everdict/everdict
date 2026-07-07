// Live e2e (faithful version): measure hermes-desktop's pinch performance against the *produced workspace files* — grade
// not the chat message but the output files the agent actually wrote, using the task .md's own rubric (## LLM Judge Rubric /
// Grading Criteria) (PinchBench's original method). Improved over pinch-hermes-measure.mjs (grades only the final message → underrates results written to files).
// Flow: control plane (dev) → register pinch benchmark/harness → per task [mount workspace + seed input files → hermes -z (CWD=/work)
//   → collect produced output files → judge-grade with the task rubric] → POST /scorecards/ingest (history) → GET output.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const CP_PORT = process.env.CP_PORT ?? "8790";
const BASE = `http://127.0.0.1:${CP_PORT}`;
const H = { "content-type": "application/json", "x-everdict-tenant": "default" };
const AGENT_MODEL = process.env.HERMES_MODEL ?? "gpt-5.4-mini";
const JUDGE_MODEL = process.env.EVERDICT_JUDGE_MODEL ?? "gpt-5.4-mini";
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
  console.error("No LLM key.");
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

// task_*.md → {id, prompt(## Prompt), rubric(## LLM Judge Rubric + Grading Criteria), inputs:[{path,content}]}
async function fetchTask(id) {
  const md = await (await fetch(`https://raw.githubusercontent.com/pinchbench/skill/main/tasks/${id}.md`)).text();
  const fm = md.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const front = fm ? fm[1] : "";
  const body = fm ? fm[2] : md;
  const section = (name) => {
    const m = body.match(new RegExp(`##+\\s*${name}[\\s\\S]*?(?=\\n##\\s|$)`, "i"));
    return m ? m[0].trim() : "";
  };
  const prompt = section("Prompt") || body.slice(0, 600);
  const rubric =
    `${section("Grading Criteria")}\n\n${section("LLM Judge Rubric")}`.trim() ||
    "Grade if the task is fully and correctly completed.";
  const inputs = [];
  for (const m of front.matchAll(/-\s*path:\s*"([^"]+)"\n\s*content:\s*\|\n([\s\S]*?)(?=\n\s*-\s*path:|\n\w+:|$)/g)) {
    inputs.push({ path: m[1], content: m[2].replace(/^ {6}/gm, "") });
  }
  return { id, prompt: prompt.replace(/^##+\s*Prompt\s*/i, "").trim(), rubric, inputs };
}

// Run hermes in the workspace (/work, host mount) → collect produced output files (excluding inputs). Read files via a container to avoid perms issues.
function runInWorkspace(t) {
  const ws = mkdtempSync(join(tmpdir(), "pinch-ws-"));
  for (const f of t.inputs) {
    const p = join(ws, f.path);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, f.content);
  }
  const inputNames = new Set(t.inputs.map((f) => f.path));
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
        "220",
        "hermes",
        "-z",
        t.prompt,
        "--yolo",
      ],
      { encoding: "utf8", timeout: 260000, maxBuffer: 10 * 1024 * 1024 },
    ).trim();
  } catch (e) {
    chat = `(hermes error: ${e instanceof Error ? e.message.slice(0, 120) : e})`;
  }
  // Collect produced files (cat via container — avoids perms on root-created files). <<<F:name>>> delimiter.
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
        'cd /work && for f in $(ls -A 2>/dev/null); do [ -f "$f" ] && printf "<<<F:%s>>>\\n" "$f" && cat "$f"; done',
      ],
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
    );
  } catch {}
  // Split per file by the <<<F:name>>> delimiter — excluding input/hidden files = the output the agent produced.
  const files = [];
  const parts = dump.split(/<<<F:(.+?)>>>\n/);
  for (let i = 1; i < parts.length; i += 2) {
    const name = parts[i];
    const content = (parts[i + 1] ?? "").trim();
    if (!inputNames.has(name) && !name.startsWith(".")) files.push({ name, content });
  }
  return { chat, files, ws };
}

console.log("=== control plane start (dev) ===");
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

  console.log(`\n=== load ${TASK_IDS.length} PinchBench core tasks ===`);
  const tasks = [];
  for (const id of TASK_IDS) {
    try {
      const t = await fetchTask(id);
      tasks.push(t);
      console.log(`  ${id}: inputs=${t.inputs.length} rubricChars=${t.rubric.length}`);
    } catch (e) {
      console.log(`  ${id}: fetch fail ${e instanceof Error ? e.message : e}`);
    }
  }

  console.log("\n=== register pinch benchmark + hermes-desktop harness ===");
  await post("/datasets", {
    id: "pinch-core-files",
    version: "1.0.0",
    description:
      "PinchBench core — file-based grading (the agent's produced workspace files, against the task rubric).",
    tags: ["pinchbench", "file-graded"],
    cases: tasks.map((t) => ({
      id: t.id,
      env: { kind: "prompt" },
      task: t.prompt.slice(0, 200),
      graders: [{ id: "judge", config: { rubric: "produced-file rubric" } }],
      timeoutSec: 300,
      tags: ["pinchbench"],
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

  console.log(`\n=== run hermes(${AGENT_MODEL}) (workspace) + file grading (judge=${JUDGE_MODEL}, task rubric) ===`);
  const traces = [];
  for (const t of tasks) {
    const { chat, files } = runInWorkspace(t);
    const outDump = files.length
      ? files.map((f) => `### ${f.name}\n${f.content.slice(0, 3000)}`).join("\n\n")
      : `(no output file; chat=${chat.slice(0, 300)})`;
    const verdict = await llm(JUDGE_MODEL, [
      {
        role: "system",
        content:
          'You are a strict grader. Apply the task\'s own rubric to the AGENT OUTPUT FILE(S). Reply JSON: {"pass": bool, "score": 0..1, "reason": "..."}. score = weighted rubric score; pass = score >= 0.6.',
      },
      {
        role: "user",
        content: `TASK PROMPT:\n${t.prompt}\n\nTASK RUBRIC:\n${t.rubric.slice(0, 3000)}\n\nAGENT OUTPUT FILE(S):\n${outDump.slice(0, 4000)}`,
      },
    ]);
    let v = { pass: false, score: 0, reason: "parse fail" };
    try {
      v = JSON.parse(verdict.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    } catch {}
    console.log(
      `  ${t.id}: judge=${v.pass ? "PASS" : "FAIL"} (${v.score}) files=[${files.map((f) => f.name).join(",")}] — ${String(v.reason).slice(0, 90)}`,
    );
    traces.push({
      caseId: t.id,
      trace: [
        { t: 0, kind: "llm_call", model: AGENT_MODEL, cost: { inputTokens: 0, outputTokens: 0, usd: 0 }, latencyMs: 0 },
        {
          t: 1,
          kind: "message",
          role: "assistant",
          text: `produced files: ${files.map((f) => f.name).join(", ") || "(none)"}\n${outDump.slice(0, 1500)}`,
        },
      ],
      snapshot: { kind: "prompt", output: outDump.slice(0, 2000) },
      scores: [
        {
          graderId: "judge",
          metric: "judge",
          value: Number(v.score) || 0,
          pass: !!v.pass,
          detail: `[file-graded, judge=${JUDGE_MODEL}] ${String(v.reason).slice(0, 200)}`,
        },
      ],
    });
  }

  console.log("\n=== POST /scorecards/ingest (record history) ===");
  const ing = await post("/scorecards/ingest", {
    dataset: { id: "pinch-core-files", version: "1.0.0" },
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
    `\n================ recorded eval history (file-based, GET /scorecards/${String(scId).slice(0, 8)}…) ================`,
  );
  console.log(
    `  benchmark: ${rec.dataset?.id}@${rec.dataset?.version} | harness: ${rec.harness?.id}@${rec.harness?.version} | ${rec.status}`,
  );
  console.log(`  performance (aggregate): ${JSON.stringify(rec.summary)}`);
  for (const r of rec.scorecard?.results ?? []) {
    const j = r.scores?.find((s) => s.metric === "judge");
    console.log(
      `   - ${r.caseId}: judge=${j?.pass ? "PASS" : "FAIL"}(${j?.value}) — ${String(j?.detail).slice(0, 100)}`,
    );
  }
  const j = (rec.summary ?? []).find((m) => m.metric === "judge");
  console.log(
    `\n  → pinch performance (file-based): judge passRate=${((j?.passRate ?? 0) * 100) | 0}% mean=${(j?.mean ?? 0).toFixed(2)} (agent=${AGENT_MODEL})`,
  );
  ok = ing.status === 202 && rec.status === "succeeded";
  console.log(
    ok
      ? "\n✅ file-based faithful grading: graded hermes's produced workspace output files against the task's own rubric → history recorded."
      : "\n⚠️ does not match expectations",
  );
} catch (e) {
  console.error("error:", e instanceof Error ? e.stack : e);
} finally {
  shutdown();
  console.log("control plane shut down.");
}
process.exit(ok ? 0 : 1);
