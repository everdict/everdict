import { type Dataset, GraderSpecSchema } from "@assay/core";
import { z } from "zod";
import { type BenchmarkAdapter, type ImportBenchmarkOpts, importBenchmark } from "./catalog.js";
import { type DatasetMeta, interpolateFields } from "./mapping.js";
import { type FetchLike, fetchHfFileRows, fetchHfRows } from "./sources.js";

// 벤치마크 정의를 JSON 직렬화 가능한 "데이터"로 — 테넌트가 자기 워크스페이스에 등록/버전관리하는 레시피.
// first-party 카탈로그 어댑터(코드: rowTransform/graderBuilder)와 달리, 이 spec 은 순수 데이터라 레지스트리에 저장 가능.

// 매핑 규칙(데이터). mapping.ts 의 CaseMapping 인터페이스와 **동형** — 이 스키마가 좁으면 유저 레시피는
// first-party 카탈로그 코드가 쓰는 env 종류(prompt/os-use)·image·placement 를 못 쓰고 조용히 브라우저 env 로
// 떨어진다(Zod 가 미지정 키를 strip). 그래서 CaseMapping 의 모든 필드를 여기 노출한다(self-serve 완전성).
export const CaseMappingSchema = z.object({
  idField: z.string(),
  taskField: z.string(),
  taskTemplate: z.string().optional(), // task 를 여러 필드로 합성({field} 보간) — 예: 질문+근거 문서 URL(OfficeQA 류)

  startUrlField: z.string().optional(),
  promptEnv: z.boolean().optional(), // true → prompt env(QA — gsm8k/GAIA). git/repoPath 가 우선.
  answerField: z.string().optional(),
  answerMode: z.enum(["contains", "exact"]).optional(),
  gitField: z.string().optional(),
  refField: z.string().optional(),
  repoPath: z.string().optional(), // 이미지-내 repo(예: SWE-bench "/testbed") — clone 안 함
  osUseEnv: z.boolean().optional(), // true → os-use(데스크탑) env — OSWorld 류
  osUseSetup: z.array(z.string()).optional(), // os-use env.setup(Xvfb 기동 등)
  display: z.string().optional(), // os-use display(기본 ":99")
  screenshotPath: z.string().optional(), // os-use 스냅샷 경로(VLM judge)
  imageField: z.string().optional(), // 행별 컴퓨트 이미지 필드
  image: z.string().optional(), // 공통 컴퓨트 이미지(imageField 가 행별로 우선)
  placement: z.string().optional(), // 모든 케이스 placement.target(등록된 런타임 id)
  testCmdField: z.string().optional(),
  tagFields: z.array(z.string()).optional(),
  extraGraders: z.array(GraderSpecSchema).optional(),
});

export const BenchmarkSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("huggingface"),
    dataset: z.string(),
    config: z.string().optional(),
    split: z.string().optional(),
    file: z.string().optional(), // 뷰어(datasets-server) 미서빙 데이터셋 폴백 — repo 데이터 파일 직접 인출(csv/jsonl/json)
    gated: z.boolean().optional(),
  }),
  z.object({ kind: z.literal("jsonl") }),
]);

// 행별 grader 템플릿 — config 문자열 값에 {field} 보간(예: command 의 applyPatch:"{test_patch}").
// graderBuilder(코드)를 데이터로 대체 → per-row SWE-bench 류 채점도 코드 없이 표현.
export const GraderTemplateSchema = z.object({
  id: z.string(),
  config: z.record(z.string()).optional(),
});

// 벤치마크 원본 출처(provenance) — SpreadsheetBench 처럼 공식 발표 벤치마크의 홈페이지/논문/코드/데이터/공식 리더보드
// 등을 레시피에 남긴다("어떤 벤치마크의 무엇인지"가 등록 후에도 보존). 표시·인용용 메타데이터라 실행/채점엔 무관.
export const BenchmarkOriginSchema = z
  .object({
    homepage: z.string().url().optional(), // 공식 홈페이지 (예: https://spreadsheetbench.github.io/)
    paper: z.string().url().optional(), // 논문 (arXiv/OpenReview 등)
    code: z.string().url().optional(), // 코드 저장소 (GitHub 등)
    data: z.string().url().optional(), // 원본 데이터셋 페이지 (HuggingFace 등)
    leaderboard: z.string().url().optional(), // 공식 리더보드
    authors: z.string().optional(), // 저자/소속
    license: z.string().optional(), // 라이선스 (예: CC-BY-4.0)
    citation: z.string().optional(), // 인용(bibtex 또는 텍스트)
    taskType: z.string().optional(), // 과제 유형 서술 (예: "실세계 스프레드시트 조작 (셀/시트 레벨)")
  })
  .optional();
export type BenchmarkOrigin = z.infer<typeof BenchmarkOriginSchema>;

export const BenchmarkAdapterSpecSchema = z.object({
  id: z.string(),
  version: z.string(),
  description: z.string().optional(),
  category: z.enum(["browser", "qa", "coding", "tool"]).default("qa"),
  origin: BenchmarkOriginSchema, // 원본 출처 메타데이터(홈페이지/논문/코드/데이터/공식 리더보드 등)
  source: BenchmarkSourceSchema,
  mapping: CaseMappingSchema,
  graderTemplates: z.array(GraderTemplateSchema).optional(),
});
export type BenchmarkAdapterSpec = z.infer<typeof BenchmarkAdapterSpecSchema>;

// 데이터 spec → 런타임 BenchmarkAdapter. graderTemplates 는 graderBuilder(행별 보간)로. 코드 함수 없이 데이터로 정의.
export function specToAdapter(spec: BenchmarkAdapterSpec): BenchmarkAdapter {
  const templates = spec.graderTemplates;
  return {
    id: spec.id,
    description: spec.description ?? spec.id,
    category: spec.category,
    defaultVersion: spec.version,
    source: spec.source,
    mapping: spec.mapping,
    ...(templates && templates.length > 0
      ? {
          graderBuilder: (row: Record<string, unknown>) =>
            templates.map((t) => ({
              id: t.id,
              ...(t.config
                ? {
                    config: Object.fromEntries(
                      Object.entries(t.config).map(([k, v]) => [k, interpolateFields(v, row)]),
                    ),
                  }
                : {}),
            })),
        }
      : {}),
  };
}

// 테넌트가 등록한 spec 으로 벤치마크 인입 → 등록 가능한 Dataset. HF/jsonl 모두 importBenchmark 재사용.
export function importFromSpec(
  spec: BenchmarkAdapterSpec,
  meta: DatasetMeta,
  opts: ImportBenchmarkOpts = {},
): Promise<Dataset> {
  return importBenchmark(specToAdapter(spec), meta, opts);
}

export type BenchmarkSourceSpec = z.infer<typeof BenchmarkSourceSchema>;

// 소스에서 원본 행 N개를 매핑 전 그대로 인출 — "벤치마크 추가" 위저드의 미리보기/필드 자동감지용.
// HF 는 fetchHfRows(소량), jsonl 은 opts.text 의 앞 N줄을 파싱. mapping 을 모르고도 실제 필드/샘플을 보여준다.
export async function fetchSourceRows(
  source: BenchmarkSourceSpec,
  opts: { limit?: number; token?: string; text?: string; fetchImpl?: FetchLike } = {},
): Promise<Array<Record<string, unknown>>> {
  const limit = Math.max(1, opts.limit ?? 5);
  if (source.kind === "huggingface") {
    // file 이 지정되면 뷰어(datasets-server) 대신 repo 파일 직접 인출(뷰어 미서빙 데이터셋 폴백).
    if (source.file) {
      return fetchHfFileRows(
        { dataset: source.dataset, file: source.file, limit, ...(opts.token ? { token: opts.token } : {}) },
        opts.fetchImpl,
      );
    }
    return fetchHfRows(
      {
        dataset: source.dataset,
        ...(source.config ? { config: source.config } : {}),
        ...(source.split ? { split: source.split } : {}),
        limit,
        ...(opts.token ? { token: opts.token } : {}),
      },
      opts.fetchImpl,
    );
  }
  if (!opts.text) throw new Error("jsonl 소스는 text(원문)가 필요합니다.");
  return opts.text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, limit)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}
