import { type Dataset, DatasetSchema, type GraderSpec } from "@everdict/core";
// Benchmark adapters + catalog: "adding a new benchmark = one adapter (descriptor), not code".
// An adapter = {source (where to pull from), mapping (fields→EvalCase), scoring (graders), optional row normalization}. First-party adapters are
// shipped as a catalog (to seed _shared); users add their own adapter to register a private/new benchmark in their workspace.
import { type CaseMapping, type DatasetMeta, WEBVOYAGER_MAPPING, rowToCase, rowsToDataset } from "./mapping.js";
import { type FetchLike, fetchHfFileRows, fetchHfRows } from "./sources.js";

// Where the benchmark lives. huggingface = HF Hub (most new benchmarks), jsonl = inline/local text (caller-provided).
export type BenchmarkSource =
  | { kind: "huggingface"; dataset: string; config?: string; split?: string; file?: string; gated?: boolean }
  | { kind: "jsonl" };

export interface BenchmarkAdapter {
  id: string;
  description: string;
  category: "browser" | "qa" | "coding" | "tool" | "desktop"; // informational classification (separate from the core env kind)
  defaultVersion: string; // catalog reference version (benchmark config/release)
  source: BenchmarkSource;
  mapping: CaseMapping;
  // Row normalization before mapping (e.g. extract only the final answer from gsm8k's "…#### 18"). The catalog is code-defined, so functions are allowed.
  rowTransform?: (row: Record<string, unknown>) => Record<string, unknown>;
  // Per-row structured grader (something the mapping's field-based form can't express — e.g. SWE-bench's swe-bench grader{test_patch,
  // FAIL_TO_PASS, PASS_TO_PASS}). The return value is appended to the case graders.
  graderBuilder?: (row: Record<string, unknown>) => GraderSpec[];
}

// Rows → Dataset (pure, no network). Apply rowTransform then map (+per-row graderBuilder) → a validated Dataset.
export function adapterToDataset(
  adapter: BenchmarkAdapter,
  rows: Array<Record<string, unknown>>,
  meta: DatasetMeta,
): Dataset {
  const mapped = adapter.rowTransform ? rows.map(adapter.rowTransform) : rows;
  if (!adapter.graderBuilder) return rowsToDataset(mapped, meta, adapter.mapping);
  const build = adapter.graderBuilder;
  const cases = mapped.map((r, i) => {
    const c = rowToCase(r, i, meta, adapter.mapping);
    return { ...c, graders: [...c.graders, ...build(r)] };
  });
  return DatasetSchema.parse({
    id: meta.id,
    version: meta.version,
    description: meta.description,
    cases,
    tags: meta.tags ?? [],
  });
}

export interface ImportBenchmarkOpts {
  limit?: number; // upper bound on fetched rows
  token?: string; // for gated HF benchmarks (tenant SecretStore)
  text?: string; // raw text for the jsonl source (local/inline)
  fetchImpl?: FetchLike; // test injection
}

// Fetch a benchmark via the adapter → a Dataset registrable to the tenant. HF sources use fetchHfRows; jsonl sources need opts.text.
export async function importBenchmark(
  adapter: BenchmarkAdapter,
  meta: DatasetMeta,
  opts: ImportBenchmarkOpts = {},
): Promise<Dataset> {
  if (adapter.source.kind === "huggingface") {
    // file specified = fallback for datasets the viewer doesn't serve (fetch the repo file directly). If limit is unset, the whole file (the viewer path defaults to 100).
    const rows = adapter.source.file
      ? await fetchHfFileRows(
          {
            dataset: adapter.source.dataset,
            file: adapter.source.file,
            ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
            ...(opts.token ? { token: opts.token } : {}),
          },
          opts.fetchImpl,
        )
      : await fetchHfRows(
          {
            dataset: adapter.source.dataset,
            config: adapter.source.config,
            split: adapter.source.split,
            limit: opts.limit ?? 100,
            token: opts.token,
          },
          opts.fetchImpl,
        );
    return adapterToDataset(adapter, rows, meta);
  }
  if (!opts.text) throw new Error(`adapter ${adapter.id}: jsonl source requires opts.text`);
  const rows = opts.text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  return adapterToDataset(adapter, rows, meta);
}

// gsm8k answer normalization: "…#### 18" → "18" (raw if absent). So answer-match compares only the final answer.
function gsm8kFinal(row: Record<string, unknown>): Record<string, unknown> {
  const a = String(row.answer ?? "");
  const g = /####\s*(.+?)\s*$/.exec(a)?.[1];
  return { ...row, _final: g != null ? g.trim() : a };
}

// WebVoyager scoring rubric (judge). Official WebVoyager has GPT-4V judge the trajectory/screenshot — here it's a trace/dom judge.
const WEBVOYAGER_RUBRIC =
  "Judge whether the agent successfully completed the web browsing task and reported a correct, " +
  "well-supported final answer. Pass only if the task goal was actually achieved by the actions in the trace.";

// Name of the official SWE-bench prebuilt image (bundling deps + repo@base_commit). Docker Hub convention (verified): __ in instance_id → _1776_.
// e.g. astropy__astropy-12907 → swebench/sweb.eval.x86_64.astropy_1776_astropy-12907:latest
export function sweBenchImage(instanceId: string, arch = "x86_64"): string {
  return `swebench/sweb.eval.${arch}.${instanceId.replaceAll("__", "_1776_")}:latest`;
}

// SWE-bench normalization: instance_id→official prebuilt image (_image, bundling repo@base_commit + deps).
// The repo is already checked out at /testbed in the image, so no clone is needed (env.source={path:/testbed}).
// test_patch/FAIL_TO_PASS/PASS_TO_PASS become a swe-bench grader via graderBuilder.
function sweBenchRow(row: Record<string, unknown>): Record<string, unknown> {
  const instanceId = String(row.instance_id ?? "");
  return { ...row, _image: instanceId ? sweBenchImage(instanceId) : "" };
}

// FAIL_TO_PASS/PASS_TO_PASS are JSON array strings → string arrays.
function jsonStrArray(v: unknown): string[] {
  try {
    const a = JSON.parse(String(v ?? "[]"));
    return Array.isArray(a) ? a.map(String) : [];
  } catch {
    return [];
  }
}

// OSWorld scoring: the official one is a per-task Python evaluator (file/state checks), hard to port harness/runtime-agnostically. Everdict has a VLM
// judge score the final desktop screenshot against the instruction (useScreenshot). The per-row instruction is baked into the rubric.
function osworldRubric(row: Record<string, unknown>): string {
  const instruction = String(row.instruction ?? row.task ?? "");
  return `Judge the final DESKTOP screenshot. PASS only if it clearly shows this task completed: "${instruction}". Judge strictly from the visible end state; if the goal is not clearly achieved on screen, FAIL.`;
}

// First-party benchmark catalog. A new benchmark just adds one adapter here (source+mapping+scoring).
// satisfies: preserves literal keys → BENCHMARK_CATALOG.gsm8k etc. are typed as non-undefined.
export const BENCHMARK_CATALOG = {
  // Generalist web-agent tasks (no final answer → action/step-based scoring). HF open.
  mind2web: {
    id: "mind2web",
    description: "Mind2Web — generalist web-agent tasks across real sites (osunlp/Mind2Web)",
    category: "browser",
    defaultVersion: "default",
    source: { kind: "huggingface", dataset: "osunlp/Mind2Web", config: "default", split: "train" },
    mapping: {
      idField: "annotation_id",
      taskField: "confirmed_task",
      tagFields: ["website", "domain", "subdomain"],
      extraGraders: [{ id: "steps" }],
    },
  },
  // Grade-school math word problems (answer matching). HF open. (Currently mapped to a browser-less browser env — prompt env is a separate follow-up.)
  gsm8k: {
    id: "gsm8k",
    description: "GSM8K — grade-school math word problems, exact-answer (openai/gsm8k)",
    category: "qa",
    defaultVersion: "main",
    source: { kind: "huggingface", dataset: "openai/gsm8k", config: "main", split: "test" },
    mapping: { idField: "id", taskField: "question", answerField: "_final", promptEnv: true },
    rowTransform: gsm8kFinal,
  },
  // General assistant benchmark (tool use + final answer). HF **gated** → needs a tenant HF token (opts.token / SecretStore).
  // Field names follow the public GAIA schema (unverified live, since it's gated).
  gaia: {
    id: "gaia",
    description: "GAIA — general assistant benchmark, tool use (gaia-benchmark/GAIA, gated; needs HF token)",
    category: "tool",
    defaultVersion: "2023_all",
    source: {
      kind: "huggingface",
      dataset: "gaia-benchmark/GAIA",
      config: "2023_all",
      split: "validation",
      gated: true,
    },
    // GAIA scoring is quasi-exact-match → answer-match exact. Environment-less QA → prompt env.
    mapping: {
      idField: "task_id",
      taskField: "Question",
      answerField: "Final answer",
      answerMode: "exact",
      promptEnv: true,
      tagFields: ["Level"],
    },
  },
  // Real-website browsing tasks (jsonl source, github). Scoring=judge (official WebVoyager is model-judged) + answer-match + steps.
  webvoyager: {
    id: "webvoyager",
    description: "WebVoyager — real-website browsing tasks, model-judged (github.com/MinorJerry/WebVoyager)",
    category: "browser",
    defaultVersion: "1.0.0",
    source: { kind: "jsonl" },
    mapping: {
      ...WEBVOYAGER_MAPPING,
      extraGraders: [{ id: "steps" }, { id: "judge", config: { rubric: WEBVOYAGER_RUBRIC } }],
    },
  },
  // Coding (repo) benchmark — scored by passing target tests after the patch (tests-pass). HF open. repo env (git+base_commit).
  "swe-bench-lite": {
    id: "swe-bench-lite",
    description: "SWE-bench Lite — resolve real GitHub issues, graded by tests (princeton-nlp/SWE-bench_Lite)",
    category: "coding",
    defaultVersion: "test",
    source: { kind: "huggingface", dataset: "princeton-nlp/SWE-bench_Lite", config: "default", split: "test" },
    mapping: {
      idField: "instance_id",
      taskField: "problem_statement",
      repoPath: "/testbed", // in-image repo (SWE-bench convention) — no clone, the coding agent works on it directly
      imageField: "_image", // official prebuilt image (deps+repo) — as the per-case compute image
      tagFields: ["repo", "version"],
    },
    rowTransform: sweBenchRow,
    // Scoring: after applying the gold test_patch, FAIL_TO_PASS (pass) + PASS_TO_PASS (hold) → resolved (official SWE-bench resolution).
    graderBuilder: (row) => [
      {
        id: "swe-bench",
        config: {
          testPatch: String(row.test_patch ?? ""),
          failToPass: jsonStrArray(row.FAIL_TO_PASS),
          passToPass: jsonStrArray(row.PASS_TO_PASS),
        },
      },
    ],
  },
  // Desktop (OS/app) computer-use benchmark — OSWorld. os-use env + VLM judge (screenshot). The official one is VM + per-task Python
  // evaluator, but Everdict adapts it to os-use docker (agent=command harness, scoring=judge). Source=jsonl (upload the OSWorld task
  // JSON as jsonl). The desktop image (with apps) is built/registered by the user — same pattern as SWE-bench prebuilt.
  osworld: {
    id: "osworld",
    description: "OSWorld — real desktop OS/app computer-use tasks (xlang-ai/OSWorld); os-use env, VLM-judged",
    category: "desktop",
    defaultVersion: "1.0.0",
    source: { kind: "jsonl" },
    mapping: {
      idField: "id",
      taskField: "instruction",
      osUseEnv: true,
      // Xvfb (virtual display) + a lightweight WM (openbox: so apps get input focus/window management). The agent launches and manipulates the app.
      osUseSetup: [
        "Xvfb :99 -screen 0 1280x900x24 -nolisten tcp >/tmp/xvfb.log 2>&1 & sleep 2",
        "openbox >/tmp/wm.log 2>&1 & sleep 1",
      ],
      display: ":99",
      screenshotPath: "/tmp/osuse.png",
      image: "everdict-osworld:demo", // OSWorld desktop image (bundling apps) — built/registered by the user. image drives container routing (docker capability), so a separate placement pin is unnecessary.
      tagFields: ["snapshot", "source"],
    },
    // Scoring: VLM judge (screenshot) + optional state check. If row.verify (a shell command, the portable counterpart to the OSWorld evaluator) exists,
    // a command grader (exit code=pass) verifies the actual system state — by file/state, not pixels (dual scoring). cwd is an absolute /tmp since
    // os-use does not create a work directory.
    graderBuilder: (row) => {
      const graders: GraderSpec[] = [{ id: "judge", config: { useScreenshot: true, rubric: osworldRubric(row) } }];
      const verify = String(row.verify ?? "").trim();
      if (verify) graders.push({ id: "command", config: { cmd: verify, cwd: "/tmp", metric: "state" } });
      return graders;
    },
  },
} satisfies Record<string, BenchmarkAdapter>;

// Look up an adapter by id (CLI/dynamic access). Throws if absent.
export function getBenchmark(id: string): BenchmarkAdapter {
  const a = (BENCHMARK_CATALOG as Record<string, BenchmarkAdapter>)[id];
  if (!a) throw new Error(`unknown benchmark "${id}" (known: ${Object.keys(BENCHMARK_CATALOG).join(", ")})`);
  return a;
}

// Catalog summary (for the list UI/CLI). Notes the source kind (huggingface=fetch by ID / jsonl=needs a file upload) and gated.
export function listBenchmarks(): Array<{
  id: string;
  category: string;
  source: BenchmarkSource["kind"];
  gated: boolean;
  defaultVersion: string;
  description: string;
}> {
  return Object.values(BENCHMARK_CATALOG).map((a) => ({
    id: a.id,
    category: a.category,
    source: a.source.kind,
    gated: a.source.kind === "huggingface" && "gated" in a.source && a.source.gated === true,
    defaultVersion: a.defaultVersion,
    description: a.description,
  }));
}
