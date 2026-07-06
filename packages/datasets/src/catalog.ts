import { type Dataset, DatasetSchema, type GraderSpec } from "@assay/core";
// 벤치마크 어댑터 + 카탈로그: "새 벤치마크 추가 = 코드가 아니라 어댑터(서술자) 한 개".
// 어댑터 = {소스(어디서 당기나), 매핑(필드→EvalCase), 채점(graders), 선택적 행 정규화}. first-party 어댑터는
// 카탈로그로 배포(_shared 시드용), 유저는 자기 어댑터를 추가해 사설/신규 벤치마크를 워크스페이스에 등록.
import { type CaseMapping, type DatasetMeta, WEBVOYAGER_MAPPING, rowToCase, rowsToDataset } from "./mapping.js";
import { type FetchLike, fetchHfFileRows, fetchHfRows } from "./sources.js";

// 벤치마크가 사는 곳. huggingface = HF Hub(대부분의 신규 벤치마크), jsonl = 인라인/로컬 텍스트(호출자 제공).
export type BenchmarkSource =
  | { kind: "huggingface"; dataset: string; config?: string; split?: string; file?: string; gated?: boolean }
  | { kind: "jsonl" };

export interface BenchmarkAdapter {
  id: string;
  description: string;
  category: "browser" | "qa" | "coding" | "tool" | "desktop"; // 정보용 분류(core env 종류와 별개)
  defaultVersion: string; // 카탈로그 기준 버전(벤치마크 config/release)
  source: BenchmarkSource;
  mapping: CaseMapping;
  // 매핑 전 행 정규화(예: gsm8k 의 "…#### 18" 에서 최종답만 추출). 카탈로그는 코드 정의라 함수 사용 가능.
  rowTransform?: (row: Record<string, unknown>) => Record<string, unknown>;
  // 행별 구조화 grader(매핑의 필드-기반으로 표현 못 하는 것 — 예: SWE-bench 의 swe-bench grader{test_patch,
  // FAIL_TO_PASS, PASS_TO_PASS}). 반환값을 케이스 graders 에 덧붙인다.
  graderBuilder?: (row: Record<string, unknown>) => GraderSpec[];
}

// 행 → Dataset (순수, 네트워크 없음). rowTransform 적용 후 매핑(+행별 graderBuilder) → 검증된 Dataset.
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
    // file 지정 = 뷰어 미서빙 데이터셋 폴백(repo 파일 직접 인출). limit 미지정이면 파일 전체(뷰어 경로는 기본 100).
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

// 공식 SWE-bench prebuilt 이미지(deps + repo@base_commit 동봉) 명. Docker Hub 규칙(검증됨): instance_id 의 __ → _1776_.
// 예: astropy__astropy-12907 → swebench/sweb.eval.x86_64.astropy_1776_astropy-12907:latest
export function sweBenchImage(instanceId: string, arch = "x86_64"): string {
  return `swebench/sweb.eval.${arch}.${instanceId.replaceAll("__", "_1776_")}:latest`;
}

// SWE-bench 정규화: instance_id→공식 prebuilt 이미지(_image, repo@base_commit + deps 동봉).
// repo 는 이미지 안 /testbed 에 이미 체크아웃돼 있어 clone 불필요(env.source={path:/testbed}).
// test_patch/FAIL_TO_PASS/PASS_TO_PASS 는 graderBuilder 가 swe-bench grader 로.
function sweBenchRow(row: Record<string, unknown>): Record<string, unknown> {
  const instanceId = String(row.instance_id ?? "");
  return { ...row, _image: instanceId ? sweBenchImage(instanceId) : "" };
}

// FAIL_TO_PASS/PASS_TO_PASS 는 JSON 배열 문자열 → 문자열 배열.
function jsonStrArray(v: unknown): string[] {
  try {
    const a = JSON.parse(String(v ?? "[]"));
    return Array.isArray(a) ? a.map(String) : [];
  } catch {
    return [];
  }
}

// OSWorld 채점: 공식은 태스크별 파이썬 evaluator(파일/상태 검사)라 하니스/런타임-무관 이식이 어렵다. assay 는 최종
// 데스크탑 스크린샷을 VLM judge 가 instruction 기준으로 채점(useScreenshot). 행별 instruction 을 루브릭에 박는다.
function osworldRubric(row: Record<string, unknown>): string {
  const instruction = String(row.instruction ?? row.task ?? "");
  return `Judge the final DESKTOP screenshot. PASS only if it clearly shows this task completed: "${instruction}". Judge strictly from the visible end state; if the goal is not clearly achieved on screen, FAIL.`;
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
    mapping: { idField: "id", taskField: "question", answerField: "_final", promptEnv: true },
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
    // GAIA 채점은 quasi-exact-match → answer-match exact. 환경 없는 QA → prompt env.
    mapping: {
      idField: "task_id",
      taskField: "Question",
      answerField: "Final answer",
      answerMode: "exact",
      promptEnv: true,
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
      repoPath: "/testbed", // 이미지-내 repo(SWE-bench 관례) — clone 안 함, 코딩 에이전트가 직접 작업
      imageField: "_image", // 공식 prebuilt 이미지(deps+repo) — per-case 컴퓨트 이미지로
      tagFields: ["repo", "version"],
    },
    rowTransform: sweBenchRow,
    // 채점: gold test_patch 적용 후 FAIL_TO_PASS(통과)+PASS_TO_PASS(유지) → resolved (공식 SWE-bench resolution).
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
  // 데스크탑(OS/앱) 컴퓨터-유즈 벤치마크 — OSWorld. os-use env + VLM judge(스크린샷). 공식은 VM + 태스크별 파이썬
  // evaluator 지만, assay 는 os-use docker 로 어댑트(에이전트=command 하니스, 채점=judge). 소스=jsonl(OSWorld task
  // JSON 을 jsonl 로 업로드). 데스크탑 이미지(앱 포함)는 유저가 빌드/등록 — SWE-bench prebuilt 와 동일 패턴.
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
      // Xvfb(가상 디스플레이) + 경량 WM(openbox: 앱이 입력 포커스/창관리를 받도록). 에이전트가 앱을 띄워 조작한다.
      osUseSetup: [
        "Xvfb :99 -screen 0 1280x900x24 -nolisten tcp >/tmp/xvfb.log 2>&1 & sleep 2",
        "openbox >/tmp/wm.log 2>&1 & sleep 1",
      ],
      display: ":99",
      screenshotPath: "/tmp/osuse.png",
      image: "assay-osworld:demo", // OSWorld 데스크탑 이미지(앱 동봉) — 유저가 빌드/등록. image 가 컨테이너 라우팅(docker capability)을 구동하므로 별도 placement 핀 불필요.
      tagFields: ["snapshot", "source"],
    },
    // 채점: VLM judge(스크린샷) + 선택적 상태검사. row.verify(셸 명령, OSWorld evaluator 의 이식형 대응)가 있으면
    // command grader(종료코드=pass)로 실제 시스템 상태를 검증한다 — 픽셀이 아니라 파일/상태로(이중 채점). cwd 는 os-use
    // 가 work 디렉터리를 안 만드므로 절대경로 /tmp.
    graderBuilder: (row) => {
      const graders: GraderSpec[] = [{ id: "judge", config: { useScreenshot: true, rubric: osworldRubric(row) } }];
      const verify = String(row.verify ?? "").trim();
      if (verify) graders.push({ id: "command", config: { cmd: verify, cwd: "/tmp", metric: "state" } });
      return graders;
    },
  },
} satisfies Record<string, BenchmarkAdapter>;

// id 로 어댑터 조회(CLI/동적 접근). 없으면 throw.
export function getBenchmark(id: string): BenchmarkAdapter {
  const a = (BENCHMARK_CATALOG as Record<string, BenchmarkAdapter>)[id];
  if (!a) throw new Error(`unknown benchmark "${id}" (known: ${Object.keys(BENCHMARK_CATALOG).join(", ")})`);
  return a;
}

// 카탈로그 요약(목록 UI/CLI 용). source 종류(huggingface=ID 인출 / jsonl=파일 업로드 필요)와 gated 표기.
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
