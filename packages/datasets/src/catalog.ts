import type { Dataset } from "@assay/core";
// 벤치마크 어댑터 + 카탈로그: "새 벤치마크 추가 = 코드가 아니라 어댑터(서술자) 한 개".
// 어댑터 = {소스(어디서 당기나), 매핑(필드→EvalCase), 채점(graders), 선택적 행 정규화}. first-party 어댑터는
// 카탈로그로 배포(_shared 시드용), 유저는 자기 어댑터를 추가해 사설/신규 벤치마크를 워크스페이스에 등록.
import { type CaseMapping, type DatasetMeta, WEBVOYAGER_MAPPING, rowsToDataset } from "./mapping.js";
import { type FetchLike, fetchHfRows } from "./sources.js";

// 벤치마크가 사는 곳. huggingface = HF Hub(대부분의 신규 벤치마크), jsonl = 인라인/로컬 텍스트(호출자 제공).
export type BenchmarkSource =
  | { kind: "huggingface"; dataset: string; config?: string; split?: string; gated?: boolean }
  | { kind: "jsonl" };

export interface BenchmarkAdapter {
  id: string;
  description: string;
  category: "browser" | "qa" | "coding" | "tool"; // 정보용 분류(core env 종류와 별개)
  defaultVersion: string; // 카탈로그 기준 버전(벤치마크 config/release)
  source: BenchmarkSource;
  mapping: CaseMapping;
  // 매핑 전 행 정규화(예: gsm8k 의 "…#### 18" 에서 최종답만 추출). 카탈로그는 코드 정의라 함수 사용 가능.
  rowTransform?: (row: Record<string, unknown>) => Record<string, unknown>;
}

// 행 → Dataset (순수, 네트워크 없음). rowTransform 적용 후 매핑 → 검증된 Dataset. 테스트 가능 핵심.
export function adapterToDataset(
  adapter: BenchmarkAdapter,
  rows: Array<Record<string, unknown>>,
  meta: DatasetMeta,
): Dataset {
  const mapped = adapter.rowTransform ? rows.map(adapter.rowTransform) : rows;
  return rowsToDataset(mapped, meta, adapter.mapping);
}

export interface ImportBenchmarkOpts {
  limit?: number; // 인출 행 수 상한
  token?: string; // gated HF 벤치마크용(테넌트 SecretStore)
  text?: string; // jsonl 소스용 원문(로컬/인라인)
  fetchImpl?: FetchLike; // 테스트 주입
}

// 어댑터로 벤치마크를 인출 → 테넌트에 등록 가능한 Dataset. HF 소스는 fetchHfRows, jsonl 소스는 opts.text 필요.
export async function importBenchmark(
  adapter: BenchmarkAdapter,
  meta: DatasetMeta,
  opts: ImportBenchmarkOpts = {},
): Promise<Dataset> {
  if (adapter.source.kind === "huggingface") {
    const rows = await fetchHfRows(
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

// gsm8k 정답 정규화: "…#### 18" → "18" (없으면 원문). answer-match 가 최종답만 비교하도록.
function gsm8kFinal(row: Record<string, unknown>): Record<string, unknown> {
  const a = String(row.answer ?? "");
  const g = /####\s*(.+?)\s*$/.exec(a)?.[1];
  return { ...row, _final: g != null ? g.trim() : a };
}

// WebVoyager 채점 루브릭(judge). 공식 WebVoyager 는 GPT-4V 가 트라젝토리/스크린샷을 판정 — 여기선 trace/dom judge.
const WEBVOYAGER_RUBRIC =
  "Judge whether the agent successfully completed the web browsing task and reported a correct, " +
  "well-supported final answer. Pass only if the task goal was actually achieved by the actions in the trace.";

// SWE-bench 정규화: repo→git URL, FAIL_TO_PASS(JSON 배열) → 타깃 테스트만 도는 pytest 명령(tests-pass cmd).
function sweBenchRow(row: Record<string, unknown>): Record<string, unknown> {
  const repo = String(row.repo ?? "");
  let tests: unknown = [];
  try {
    tests = JSON.parse(String(row.FAIL_TO_PASS ?? "[]"));
  } catch {
    tests = [];
  }
  const ids = Array.isArray(tests) ? tests.map((t) => JSON.stringify(String(t))) : [];
  return {
    ...row,
    _git: repo ? `https://github.com/${repo}.git` : "",
    _testcmd: ids.length ? `python -m pytest -q ${ids.join(" ")}` : "true",
  };
}

// first-party 벤치마크 카탈로그. 새 벤치마크는 여기에 어댑터 한 개를 추가하면 됨(소스+매핑+채점).
// satisfies: 리터럴 키를 보존 → BENCHMARK_CATALOG.gsm8k 등이 non-undefined 로 타입됨.
export const BENCHMARK_CATALOG = {
  // 일반화 웹-에이전트 태스크(최종답 없음 → 행동/스텝 기반 채점). HF open.
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
  // 초등 수학 워드프라블럼(정답 매칭). HF open. (현재 browser-less browser env 로 매핑 — prompt env 는 별도 follow-up.)
  gsm8k: {
    id: "gsm8k",
    description: "GSM8K — grade-school math word problems, exact-answer (openai/gsm8k)",
    category: "qa",
    defaultVersion: "main",
    source: { kind: "huggingface", dataset: "openai/gsm8k", config: "main", split: "test" },
    mapping: { idField: "id", taskField: "question", answerField: "_final" },
    rowTransform: gsm8kFinal,
  },
  // 일반 어시스턴트 벤치마크(툴 사용 + 최종답). HF **gated** → 테넌트 HF 토큰 필요(opts.token / SecretStore).
  // 필드명은 GAIA 공개 스키마 기준(gated 라 라이브 미검증).
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
    // GAIA 채점은 quasi-exact-match → answer-match exact.
    mapping: {
      idField: "task_id",
      taskField: "Question",
      answerField: "Final answer",
      answerMode: "exact",
      tagFields: ["Level"],
    },
  },
  // 실제 웹사이트 브라우징 태스크(jsonl 소스, github). 채점=judge(공식 WebVoyager 가 모델 판정) + answer-match + steps.
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
  // 코딩(repo) 벤치마크 — 패치 후 타깃 테스트 통과로 채점(tests-pass). HF open. repo env(git+base_commit).
  "swe-bench-lite": {
    id: "swe-bench-lite",
    description: "SWE-bench Lite — resolve real GitHub issues, graded by tests (princeton-nlp/SWE-bench_Lite)",
    category: "coding",
    defaultVersion: "test",
    source: { kind: "huggingface", dataset: "princeton-nlp/SWE-bench_Lite", config: "default", split: "test" },
    mapping: {
      idField: "instance_id",
      taskField: "problem_statement",
      gitField: "_git",
      refField: "base_commit",
      testCmdField: "_testcmd",
      tagFields: ["repo", "version"],
    },
    rowTransform: sweBenchRow,
  },
} satisfies Record<string, BenchmarkAdapter>;

// id 로 어댑터 조회(CLI/동적 접근). 없으면 throw.
export function getBenchmark(id: string): BenchmarkAdapter {
  const a = (BENCHMARK_CATALOG as Record<string, BenchmarkAdapter>)[id];
  if (!a) throw new Error(`unknown benchmark "${id}" (known: ${Object.keys(BENCHMARK_CATALOG).join(", ")})`);
  return a;
}

// 카탈로그 요약(목록 UI/CLI 용).
export function listBenchmarks(): Array<{ id: string; category: string; gated: boolean; description: string }> {
  return Object.values(BENCHMARK_CATALOG).map((a) => ({
    id: a.id,
    category: a.category,
    gated: a.source.kind === "huggingface" && "gated" in a.source && a.source.gated === true,
    description: a.description,
  }));
}
