import { BadRequestError, type Dataset, DatasetSchema, type GraderSpec } from "@everdict/contracts";
// Benchmark adapters + catalog: "adding a new benchmark = one adapter (descriptor), not code".
// An adapter = {source (where to pull from), mapping (fields→EvalCase), scoring (graders), optional row normalization}. First-party adapters are
// shipped as a catalog (to seed _shared); users add their own adapter to register a private/new benchmark in their workspace.
import { type BenchmarkJudge, GAIA_QUESTION_SCORER, GSM8K_EXACT_MATCH } from "./judges.js";
import { type CaseMapping, type DatasetMeta, WEBVOYAGER_MAPPING, rowToCase, rowsToDataset } from "./mapping.js";
import { type FetchLike, fetchHfFileRows, fetchHfRows } from "./sources.js";
import { parseTerminalBenchTasks, terminalBenchToDataset } from "./terminal-bench.js";
import { TRAVEL_BENCHMARKS } from "./travel.js";

// Where the benchmark lives. huggingface = HF Hub (most new benchmarks), jsonl = inline/local text (caller-provided).
export type BenchmarkSource =
  | { kind: "huggingface"; dataset: string; config?: string; split?: string; file?: string; gated?: boolean }
  | { kind: "jsonl" }
  // A TERMINAL-BENCH TASK SET (docs/architecture/standard-task-formats.md, slices 2-3). The caller supplies
  // the parsed task set as text — a JSON array of tasks, or one task per line — and the dedicated mapper
  // turns it into cases. It does NOT go through `CaseMapping`: a Terminal-Bench task's verdict is the reward
  // its own `tests/` publishes, which no field-mapping rule can express.
  | { kind: "terminal-bench"; imageTemplate?: string };

// WHAT A SCORE FROM THIS ADAPTER IS, as data rather than as prose (arch-review 16 P2-8).
//
// Several catalog entries cannot run their benchmark's OFFICIAL evaluator — TravelPlanner's eval.py, TREK's
// scoring.py, OSWorld's per-task Python checkers all need the benchmark's own database and its exact plan
// schema, which is precisely what a harness-agnostic runtime cannot host. Those adapters approximate the same
// constraints with a judge, and every one of them says so at length in its `description`.
//
// A sentence in a description is not a contract. Everdict treats evaluation results as trust artifacts that
// travel — into trends, exports, release gates, reports — and every one of those surfaces reads structured
// fields and drops prose. The distinction has to be machine-readable at the point where it is TRUE, or a
// proxy number eventually gets rendered as "the TREK score" by a surface that never saw the paragraph.
//
//   official  the benchmark's own evaluator runs here; the number is comparable to its leaderboard
//   proxy     the same constraints, scored a different way (usually a judge); an everdict-internal signal
//             for regression tracking, NEVER a leaderboard number
export interface BenchmarkScoringSemantics {
  kind: "official" | "proxy";
  // Why it is a proxy, and what would make it official — the one sentence a UI can show beside the number.
  // Required for `proxy`: an approximation that cannot say what it approximates is not a description of one.
  approximates?: string;
  // The evaluator that WOULD produce the official number, so a reader knows what to run to reproduce it.
  officialEvaluator?: string;
  // Data/code license as published — recorded because a benchmark's redistribution terms are part of what a
  // workspace is agreeing to when it imports the cases.
  license?: string;
}

export interface BenchmarkAdapter {
  id: string;
  description: string;
  category: "browser" | "qa" | "coding" | "tool" | "desktop"; // informational classification (separate from the core env kind)
  // How to read a score from this benchmark. Absent = `official` by omission would be a claim nobody made, so
  // readers must treat absence as UNSTATED and never as comparability — the same absence discipline the
  // scoring plane uses everywhere else.
  scoring?: BenchmarkScoringSemantics;
  defaultVersion: string; // catalog reference version (benchmark config/release)
  source: BenchmarkSource;
  // How a ROW becomes a case. Absent only for a source with its own mapper (`terminal-bench`), where the
  // fields a mapping names do not exist; `adapterToDataset` refuses rather than mapping nothing.
  mapping?: CaseMapping;
  // Row normalization before mapping (e.g. extract only the final answer from gsm8k's "…#### 18"). The catalog is code-defined, so functions are allowed.
  rowTransform?: (row: Record<string, unknown>) => Record<string, unknown>;
  // Per-row structured grader (something the mapping's field-based form can't express — e.g. SWE-bench's swe-bench grader{test_patch,
  // FAIL_TO_PASS, PASS_TO_PASS}). The return value is appended to the case graders.
  graderBuilder?: (row: Record<string, unknown>) => GraderSpec[];
  // The benchmark's OWN evaluator, ported to the code-judge contract (see judges.ts). Present only where the port
  // reproduces the official decision; absent means this package ships the cases and leaves scoring to the importer,
  // which is the honest state for a benchmark whose evaluator needs its own database.
  officialJudge?: BenchmarkJudge;
}

// Rows → Dataset (pure, no network). Apply rowTransform then map (+per-row graderBuilder) → a validated Dataset.
export function adapterToDataset(
  adapter: BenchmarkAdapter,
  rows: Array<Record<string, unknown>>,
  meta: DatasetMeta,
): Dataset {
  const mapped = adapter.rowTransform ? rows.map(adapter.rowTransform) : rows;
  // A row-mapped source with no mapping cannot produce cases, and producing empty ones would be worse than
  // saying so: the caller would register a dataset whose every case is a blank task.
  const mapping = adapter.mapping;
  if (mapping === undefined)
    throw new BadRequestError(
      "BAD_REQUEST",
      { adapter: adapter.id, source: adapter.source.kind },
      `adapter ${adapter.id}: a ${adapter.source.kind} source is mapped row by row and this one declares no mapping`,
    );
  if (!adapter.graderBuilder) return rowsToDataset(mapped, meta, mapping);
  const build = adapter.graderBuilder;
  const cases = mapped.map((r, i) => {
    const c = rowToCase(r, i, meta, mapping);
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
    // If limit is unset, import the WHOLE dataset on both paths (repo file and viewer) — an import must never
    // silently truncate (docs/datasets.md: "import is always the full dataset"); explicit limit still caps.
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
            ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
            token: opts.token,
          },
          opts.fetchImpl,
        );
    return adapterToDataset(adapter, rows, meta);
  }
  if (adapter.source.kind === "terminal-bench") {
    // The ingestion edge (slice 2): text → `TerminalBenchTask[]` → the dedicated mapper. `limit` caps the set
    // exactly as it does elsewhere; a task the mapper cannot resolve an image for THROWS rather than importing
    // a case nothing can run (Everdict references images, it never builds them).
    if (!opts.text) throw new Error(`adapter ${adapter.id}: terminal-bench source requires opts.text`);
    const tasks = parseTerminalBenchTasks(opts.text);
    const limited = opts.limit !== undefined ? tasks.slice(0, opts.limit) : tasks;
    return terminalBenchToDataset(
      limited,
      {
        id: meta.id,
        version: meta.version,
        ...(meta.description ? { description: meta.description } : {}),
        ...(meta.tags ? { tags: meta.tags } : {}),
      },
      adapter.source.imageTemplate !== undefined ? { imageTemplate: adapter.source.imageTemplate } : {},
    );
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
    scoring: {
      kind: "official",
      officialEvaluator: "openai/grade-school-math exact-match on the #### answer",
      license: "MIT",
    },
    source: { kind: "huggingface", dataset: "openai/gsm8k", config: "main", split: "test" },
    mapping: { idField: "id", taskField: "question", answerField: "_final", promptEnv: true },
    rowTransform: gsm8kFinal,
    officialJudge: GSM8K_EXACT_MATCH,
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
    // The mapping's answer-match is a plain exact comparison — enough to align cases, NOT what GAIA scores with.
    // The official quasi-exact-match (number/list/string normalization) ships as `officialJudge`, which is why this
    // entry may claim `official`: importers get the paper's own decision instead of re-deriving it.
    scoring: {
      kind: "official",
      officialEvaluator: "gaia-benchmark question_scorer (scorer.py)",
      license: "CC-BY-4.0 (gated: accept the terms on the Hub)",
    },
    mapping: {
      idField: "task_id",
      taskField: "Question",
      answerField: "Final answer",
      answerMode: "exact",
      promptEnv: true,
      tagFields: ["Level"],
    },
    officialJudge: GAIA_QUESTION_SCORER,
  },
  // Real-website browsing tasks (jsonl source, github). Scoring=judge (official WebVoyager is model-judged) + answer-match + steps.
  webvoyager: {
    id: "webvoyager",
    description:
      "WebVoyager — real-website browsing tasks, model-judged (github.com/MinorJerry/WebVoyager). Maps to a browser env (topology harnesses — Everdict provisions the browser); a self-browsing command agent (browser-use etc.) needs a promptEnv recipe instead (see examples/bundles/browser-use)",
    category: "browser",
    defaultVersion: "1.0.0",
    source: { kind: "jsonl" },
    mapping: {
      ...WEBVOYAGER_MAPPING,
      extraGraders: [{ id: "steps" }, { id: "judge", config: { rubric: WEBVOYAGER_RUBRIC } }],
    },
  },
  // ── A BENCHMARK WHOSE CASE IS A CONVERSATION AND WHOSE VERDICT IS THE WORLD'S STATE ─────────────────
  //
  // tau-bench (sierra-research/tau-bench): an agent serves a USER over several turns while calling a domain's
  // tools, and the case is decided by what the domain looks like afterwards plus whatever the user had to be
  // told. It needed two things this platform did not have, and both now exist:
  //   · a case that is a DIALOGUE with a model-driven user (world-and-engagement-model.md, axis 2) — the
  //     row's user instruction becomes the persona, bounded by maxTurns;
  //   · a world the agent ACTS ON that publishes its own final state, compared by the `world-state` grader
  //     against what the row declares (axis 1, `EnvironmentSpec.observe`).
  //
  // What the workspace supplies is the benchmark's own service — its domain database and tool APIs, run as an
  // environment that PROVIDES a world. Everdict does not ship it: the data and the tools are tau-bench's, and
  // a database invented here would be a different benchmark wearing its name.
  "tau-bench": {
    id: "tau-bench",
    description:
      "tau-bench — a multi-turn agent serving a simulated user against a domain's tools (sierra-research/tau-bench). Source jsonl: paste the domain's tasks. Each case becomes a DIALOGUE whose user is model-driven from the row's user instruction, acting on the tau-bench service the WORKSPACE hosts (register it as an environment that provides a world and publishes its final state); the verdict compares that state against the row's expected outcome",
    category: "tool",
    // The official reward is computed by tau-bench's own harness against its own database, with its own user
    // simulator and model. This runs the same TASK — same domain, same tools, same expected end state — with
    // everdict's user simulator and a state comparison over what the workspace's own deployment publishes. The
    // number is a regression signal for that deployment, never a leaderboard row.
    scoring: {
      kind: "proxy",
      approximates:
        "the official reward: the domain database's final state plus the required outputs, decided by tau-bench's own harness and user simulator",
      officialEvaluator: "sierra-research/tau-bench (tau_bench.envs · run.py)",
      license: "code MIT",
    },
    defaultVersion: "1.0.0",
    source: { kind: "jsonl" },
    mapping: {
      idField: "id",
      // The opening message is the user's first ask; the persona carries who they are and what they want, so
      // the simulator can answer follow-up questions the agent asks (which is the whole point of the format).
      taskField: "instruction",
      personaField: "user_instruction",
      maxTurns: 30,
      promptEnv: true,
      // The world's final state, as the row declares it — read by the `world-state` grader off the platform's
      // observation channel, never off the agent's own report.
      answerField: "expected_state",
      extraGraders: [{ id: "world-state" }, { id: "steps" }],
    },
  },
  // ── BROWSING BENCHMARKS, SHIPPED AS PROXIES BECAUSE THEIR EVALUATORS ARE NOT REPRODUCED HERE ─────────
  //
  // Both of these are on benchmark-evidence-spec.md §1's adapter list, and both arrive as `proxy` on purpose.
  // A `proxy` is not a lesser adapter: it is the honest reading of a port that scores the same TASK by a
  // different apparatus, and the field exists so a number can never be rendered as "the BrowseComp score" by
  // a surface that never read the paragraph. What would make either `official` is written down below, so the
  // next author is upgrading a stated gap rather than re-deriving one.
  browsecomp: {
    id: "browsecomp",
    description:
      "BrowseComp — short-answer questions that require persistent web browsing to answer (openai/simple-evals). Rows are supplied as jsonl: the published set ships ENCRYPTED (problem/answer under a per-row key), and this package does not carry a decryption it cannot verify — decrypt with the benchmark's own tooling and paste the rows. Maps to a prompt env, so a self-browsing agent answers with its own tools",
    category: "qa",
    // The official metric is itself an LLM judgment (simple-evals grades each answer with a fixed grader
    // template), so "official" would mean running THAT template on a comparable model. This ships everdict's
    // own judge with the reference answer interpolated per row: the same question, a different grader.
    scoring: {
      kind: "proxy",
      approximates: "the official grader-model verdict on whether the response's final answer matches the reference",
      officialEvaluator: "openai/simple-evals browsecomp_eval.py (GRADER_TEMPLATE)",
      license: "code MIT",
    },
    defaultVersion: "1.0.0",
    source: { kind: "jsonl" },
    mapping: {
      idField: "id",
      taskField: "problem",
      answerField: "answer",
      promptEnv: true,
      extraGraders: [{ id: "steps" }],
    },
    // The reference answer is baked into the rubric per row, which is what makes this judge decidable at all:
    // a browsing question has no verifiable form a generic rubric could check without it.
    graderBuilder: (row) => [
      {
        id: "judge",
        config: {
          rubric: `The reference answer is: ${String(row.answer ?? "")}\n\nPASS only if the response's FINAL answer is that answer (allowing formatting and surface wording to differ). A response that is well-argued but names a different answer FAILS, and so does one that never commits to an answer.`,
        },
      },
    ],
  },
  webarena: {
    id: "webarena",
    description:
      "WebArena — long-horizon tasks on self-hosted clones of real sites (web-arena-x/webarena). Source jsonl: paste the benchmark's task config files. Maps to a browser env with the task's start_url; the sites themselves are the WORKSPACE's to host, and the case's start URL must point at them",
    category: "browser",
    // WebArena decides a task with per-task functional checks (string / URL / DOM-program). The first two are
    // textual and could be ported; `program_html` inspects the LIVE page after the run, which a trace-scored
    // architecture does not have — so a port would reproduce some tasks and quietly guess at others, and a
    // per-adapter `official` claim would cover both. It stays a proxy until the checks are ported per task and
    // the unportable ones can be recorded as unmeasured rather than judged.
    scoring: {
      kind: "proxy",
      approximates:
        "the official per-task functional evaluator (string_match / url_match / program_html) over the live self-hosted sites",
      officialEvaluator: "web-arena-x/webarena evaluation_harness",
      license: "code Apache-2.0",
    },
    defaultVersion: "1.0.0",
    source: { kind: "jsonl" },
    mapping: {
      idField: "task_id",
      taskField: "intent",
      startUrlField: "start_url",
      tagFields: ["sites"],
      extraGraders: [{ id: "steps" }],
    },
    graderBuilder: (row) => [
      {
        id: "judge",
        config: {
          rubric: `Judge whether the agent completed this WebArena task from the actions in the trace and the final page state it reports: "${String(row.intent ?? "")}". PASS only if the goal was actually achieved by the actions taken. A plausible narrative with no action that accomplishes the goal FAILS, and an unachievable task ("N/A") passes only if the agent SAYS it is unachievable.`,
        },
      },
    ],
  },
  // Coding (repo) benchmark — scored by passing target tests after the patch (tests-pass). HF open. repo env (git+base_commit).
  "swe-bench-lite": {
    id: "swe-bench-lite",
    description: "SWE-bench Lite — resolve real GitHub issues, graded by tests (princeton-nlp/SWE-bench_Lite)",
    category: "coding",
    // OFFICIAL: the `swe-bench` grader applies the gold test_patch and requires FAIL_TO_PASS to pass while
    // PASS_TO_PASS holds, which IS the upstream resolution rule — not an approximation of it.
    scoring: {
      kind: "official",
      officialEvaluator: "SWE-bench harness (swebench.harness.run_evaluation)",
      license: "MIT (dataset: CC-BY-4.0)",
    },
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
  // The full, human-VALIDATED SWE-bench slice (500 instances). Same evaluator, same image convention, same
  // resolution rule — the only differences are the HuggingFace dataset and the size, which is exactly why it
  // is a sibling entry rather than a new adapter (benchmark-evidence-spec.md §1, the first adapter on the list).
  "swe-bench-verified": {
    id: "swe-bench-verified",
    description:
      "SWE-bench Verified — the 500 human-validated instances, graded by tests (princeton-nlp/SWE-bench_Verified)",
    category: "coding",
    scoring: {
      kind: "official",
      officialEvaluator: "SWE-bench harness (swebench.harness.run_evaluation)",
      license: "MIT (dataset: CC-BY-4.0)",
    },
    defaultVersion: "test",
    source: { kind: "huggingface", dataset: "princeton-nlp/SWE-bench_Verified", config: "default", split: "test" },
    mapping: {
      idField: "instance_id",
      taskField: "problem_statement",
      repoPath: "/testbed", // in-image repo (SWE-bench convention) — no clone
      imageField: "_image", // official prebuilt image (deps+repo) — as the per-case compute image
      tagFields: ["repo", "version"],
    },
    rowTransform: sweBenchRow,
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
    // a state-check grader (exit code=pass) verifies the actual system state — by file/state, not pixels (dual scoring). cwd is an absolute /tmp since
    // os-use does not create a work directory. `state-check`, not `command` with `metric: "state"`: the metric name carries ground-truth
    // authority and only the grader that produces it by construction may emit it — a `command` spec naming it was refused at scoring time.
    graderBuilder: (row) => {
      const graders: GraderSpec[] = [{ id: "judge", config: { useScreenshot: true, rubric: osworldRubric(row) } }];
      const verify = String(row.verify ?? "").trim();
      if (verify) graders.push({ id: "state-check", config: { cmd: verify, cwd: "/tmp" } });
      return graders;
    },
  },
  // Travel-planning benchmarks (travel.ts) — each carries a per-row rubric builder, so they are defined there and
  // spread in here. Spreading a const object literal preserves the literal keys, so BENCHMARK_CATALOG.trek stays typed.
  ...TRAVEL_BENCHMARKS,
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
  scoring?: BenchmarkScoringSemantics;
  // The official scorer this entry ships, as a POINTER — id/description only, never the source, because a catalog
  // listing that carried every judge's code would be mostly code. `getBenchmarkJudge` hands over the body.
  // Absent = this package ships the cases and the importer supplies the scoring.
  officialJudge?: { id: string; description: string; officialEvaluator: string };
}> {
  // Read through the declared adapter type: the literal object types differ per entry (only some carry `scoring`
  // or `officialJudge`), and a union of those has no such property to read.
  return Object.values(BENCHMARK_CATALOG as Record<string, BenchmarkAdapter>).map((a) => ({
    id: a.id,
    category: a.category,
    source: a.source.kind,
    gated: a.source.kind === "huggingface" && "gated" in a.source && a.source.gated === true,
    defaultVersion: a.defaultVersion,
    description: a.description,
    // Which of these numbers are leaderboard-comparable is the first thing a reader needs and the last thing a
    // prose description can be trusted to carry — so the listing states it (arch-review 16 P2-8).
    ...(a.scoring ? { scoring: a.scoring } : {}),
    ...(a.officialJudge
      ? {
          officialJudge: {
            id: a.officialJudge.id,
            description: a.officialJudge.description,
            officialEvaluator: a.officialJudge.officialEvaluator,
          },
        }
      : {}),
  }));
}

// The official scorer's BODY, shaped as the code judge a workspace registers (`POST /judges`). This is the half of a
// benchmark that used to be un-gettable: the cases could be imported, and the scoring had to be re-derived by hand
// from the paper — which is how two workspaces evaluating "the same benchmark" end up with two different criteria.
// Throws for an unknown benchmark; returns undefined when the benchmark ships no official port (see judges.ts).
export function getBenchmarkJudge(
  benchmarkId: string,
  version = "1.0.0",
): { kind: "code"; id: string; version: string; language: "node"; description: string; code: string } | undefined {
  const judge = getBenchmark(benchmarkId).officialJudge;
  if (!judge) return undefined;
  return {
    kind: "code",
    id: judge.id,
    version,
    language: judge.language,
    description: `${judge.description} (official evaluator: ${judge.officialEvaluator})`,
    code: judge.code,
  };
}
