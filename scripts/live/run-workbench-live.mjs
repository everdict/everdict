// Live (Nomad): the run workbench + live-replay stack S1~S3 end-to-end against a REAL alloc.
// A command harness slowly edits its seeded repo inside a Nomad docker alloc while the drill, over plain HTTP:
//   S1 — GET /runs/:id/fs (+ /fs/file) shows the live working tree with git statuses + per-file diff (exec channel)
//   S2 — GET /runs/:id/recording answers the LIVE tail (peek, envKind "live") while the run executes
//   S3 — the recording's `runtime` lane fills with orchestrator CPU/mem samples (RuntimeSamplingDispatcher)
// then after settle the same recording read returns the SEALED manifest.
//
// Setup: a running `nomad agent -dev` (docker driver) + the everdict-job-runner image + the api booted from source.
// Usage: API=http://127.0.0.1:8791 IMAGE=everdict-job-runner:slim node scripts/live/run-workbench-live.mjs
import process from "node:process";

const API = process.env.API ?? "http://127.0.0.1:8791";
const IMAGE = process.env.IMAGE ?? "everdict-job-runner:slim";
const NOMAD = process.env.NOMAD_ADDR ?? "http://127.0.0.1:4646";
const HEADERS = { "content-type": "application/json", "x-everdict-tenant": "default" };

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const req = async (method, path, body) => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: HEADERS,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ① Register the drill runtime (the local nomad dev agent) + the slow-editor command harness.
const stamp = Date.now().toString(36);
const runtimeId = `drill-nomad-${stamp}`;
const harnessId = `drill-editor-${stamp}`;

{
  const res = await req("POST", "/runtimes", {
    kind: "nomad",
    id: runtimeId,
    version: "1.0.0",
    addr: NOMAD,
    image: IMAGE,
    tags: ["live-drill"],
  });
  check("runtime registered", res.status < 300, `${res.status} ${res.status >= 300 ? res.text.slice(0, 200) : ""}`);
}
{
  // Edits the seeded repo in three beats so the fs endpoints can watch it change, then idles long enough
  // for at least two 10s runtime samples before exiting. Template (structure) + instance (pin-less) pair —
  // /harnesses is the instance surface since the template/instance split.
  const command =
    'sh -c \'echo "print(1)" >> a.py && rm -f gone.txt && printf "def b():\\n    pass\\n" > b.py && sleep 45 && echo done\'';
  const template = await req("POST", "/harness-templates", {
    kind: "command",
    category: "live-drill",
    id: harnessId,
    version: "1.0.0",
    setup: [],
    command,
    trace: { kind: "none" },
  });
  check(
    "harness template registered",
    template.status < 300,
    `${template.status} ${template.status >= 300 ? template.text.slice(0, 200) : ""}`,
  );
  const res = await req("POST", "/harnesses", {
    template: { id: harnessId, version: "1.0.0" },
    id: harnessId,
    version: "1.0.0",
  });
  check(
    "harness instance registered",
    res.status < 300,
    `${res.status} ${res.status >= 300 ? res.text.slice(0, 200) : ""}`,
  );
}

// ② Submit the run onto the drill runtime.
const caseId = `wb-${stamp}`;
let runId;
{
  const res = await req("POST", "/runs", {
    harness: { id: harnessId, version: "1.0.0" },
    runtime: runtimeId,
    case: {
      id: caseId,
      env: { kind: "repo", source: { files: { "a.py": "print(0)\n", "gone.txt": "bye\n" } } },
      task: "edit the repo slowly",
      graders: [],
      timeoutSec: 180,
      tags: ["live", "workbench"],
    },
  });
  runId = res.json?.id;
  check("run submitted", res.status < 300 && Boolean(runId), `${res.status} run=${runId ?? res.text.slice(0, 200)}`);
  if (!runId) process.exit(1);
}

// ③ Wait for the alloc to run, then S1: the live repo file tree + one file's content/diff over the exec channel.
let fsOut;
{
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const res = await req("GET", `/runs/${runId}/fs`);
    if (res.json?.found) {
      fsOut = res.json;
      break;
    }
    await sleep(3000);
  }
  const byPath = new Map((fsOut?.files ?? []).map((f) => [f.path, f.status]));
  check("S1 fs tree found (live working tree over exec)", Boolean(fsOut), JSON.stringify(fsOut?.files ?? []));
  check(
    "S1 statuses: a.py modified · b.py added · gone.txt deleted",
    byPath.get("a.py") === "modified" && byPath.get("b.py") === "added" && byPath.get("gone.txt") === "deleted",
    JSON.stringify([...byPath]),
  );
}
{
  const res = await req("GET", `/runs/${runId}/fs/file?path=a.py`);
  const f = res.json;
  check(
    "S1 fs file: content decoded + working-tree diff rides along",
    Boolean(f?.found) &&
      f.content.includes("print(0)") &&
      f.content.includes("print(1)") &&
      f.diff.includes("+print(1)"),
    `size=${f?.size} diff=${(f?.diff ?? "").split("\n").find((l) => l.startsWith("+print"))}`,
  );
}

// ④ S2/S3: the recording answers LIVE (peek) while the run executes, and the runtime lane fills with samples.
{
  let live;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const res = await req("GET", `/runs/${runId}/recording`);
    if (res.json?.found && (res.json.recording?.tracks?.runtime?.length ?? 0) >= 1) {
      live = res.json;
      break;
    }
    await sleep(4000);
  }
  const rec = live?.recording;
  check(
    "S2 live recording tail (peek) while still running",
    Boolean(rec) && live.status !== "succeeded",
    `status=${live?.status} envKind=${rec?.envKind}`,
  );
  check("S2 provisional envKind=live before seal", rec?.envKind === "live", `envKind=${rec?.envKind}`);
  const sample = rec?.tracks?.runtime?.[0];
  check(
    "S3 runtime lane fills from the orchestrator stats sampler",
    Boolean(sample) && (sample.cpuPct !== undefined || sample.memBytes !== undefined),
    JSON.stringify(sample),
  );
}

// ⑤ Settle, then the SAME read returns the sealed recording.
{
  let record;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const res = await req("GET", `/runs/${runId}`);
    record = res.json;
    if (record?.status === "succeeded" || record?.status === "failed") break;
    await sleep(4000);
  }
  check(
    "run settled",
    record?.status === "succeeded",
    `status=${record?.status} error=${JSON.stringify(record?.error ?? null).slice(0, 200)}`,
  );

  const res = await req("GET", `/runs/${runId}/recording`);
  const rec = res.json?.recording;
  check(
    "sealed recording keeps the runtime samples + names the env kind",
    Boolean(rec) && rec.envKind !== "live" && (rec.tracks?.runtime?.length ?? 0) >= 1,
    `envKind=${rec?.envKind} runtimeSamples=${rec?.tracks?.runtime?.length ?? 0} lanes=${Object.keys(rec?.tracks ?? {}).join(",")}`,
  );
}

const failed = results.filter((r) => !r.ok);
console.log(
  failed.length === 0 ? "\n✅ PASS — run workbench S1~S3 live on Nomad" : `\n❌ FAIL — ${failed.length} checks failed`,
);
process.exit(failed.length === 0 ? 0 : 1);
