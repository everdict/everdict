import { type Dataset, GraderSpecSchema } from "@assay/core";
import { z } from "zod";
import { type BenchmarkAdapter, type ImportBenchmarkOpts, importBenchmark } from "./catalog.js";
import type { DatasetMeta } from "./mapping.js";

// 벤치마크 정의를 JSON 직렬화 가능한 "데이터"로 — 테넌트가 자기 워크스페이스에 등록/버전관리하는 레시피.
// first-party 카탈로그 어댑터(코드: rowTransform/graderBuilder)와 달리, 이 spec 은 순수 데이터라 레지스트리에 저장 가능.

// 매핑 규칙(데이터). mapping.ts 의 CaseMapping 인터페이스와 동형(여기선 Zod 로 검증/저장 가능하게).
export const CaseMappingSchema = z.object({
  idField: z.string(),
  taskField: z.string(),
  startUrlField: z.string().optional(),
  answerField: z.string().optional(),
  answerMode: z.enum(["contains", "exact"]).optional(),
  gitField: z.string().optional(),
  refField: z.string().optional(),
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

export const BenchmarkAdapterSpecSchema = z.object({
  id: z.string(),
  version: z.string(),
  description: z.string().optional(),
  category: z.enum(["browser", "qa", "coding", "tool"]).default("qa"),
  source: BenchmarkSourceSchema,
  mapping: CaseMappingSchema,
  graderTemplates: z.array(GraderTemplateSchema).optional(),
});
export type BenchmarkAdapterSpec = z.infer<typeof BenchmarkAdapterSpecSchema>;

// {field} 보간 — 행에서 값 치환(없으면 빈 문자열).
function interpolate(tpl: string, row: Record<string, unknown>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => {
    const v = row[k];
    return v == null ? "" : String(v);
  });
}

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
                ? { config: Object.fromEntries(Object.entries(t.config).map(([k, v]) => [k, interpolate(v, row)])) }
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
