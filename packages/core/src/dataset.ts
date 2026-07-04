import { z } from "zod";
import { EvalCaseSchema } from "./eval-case.js";

// 데이터셋: eval 케이스 묶음 — 하니스 무관(어느 하니스@버전이든 같은 케이스로 돌려 공정 비교).
// 버전 불변(레지스트리가 강제) — baseline↔candidate 비교가 재현 가능하려면 케이스가 고정돼야 한다.
// core 의 Suite 와 구분: Suite 는 harness.id 에 묶이고 비버전, Dataset 은 하니스 무관 + 버전 관리.
// 원본 데이터 출처(리니지) — 케이스 행이 실제로 어디서 왔나. HuggingFace 데이터셋/파일/split + 정규 링크.
// 데이터셋 상세가 "이 데이터가 어디서 왔는지"를 링크로 보이게 하는 근거(리니지). 인입 시점에 각인(불변).
export const DatasetSourceRefSchema = z.object({
  kind: z.enum(["huggingface", "jsonl"]),
  dataset: z.string().optional(), // HF: org/name
  config: z.string().optional(), // HF config
  split: z.string().optional(), // HF split
  file: z.string().optional(), // 뷰어 미서빙 폴백의 repo 파일(예: officeqa_pro.csv)
  url: z.string().optional(), // 정규 링크(HF 데이터셋 페이지)
});
export type DatasetSourceRef = z.infer<typeof DatasetSourceRefSchema>;

// 발표 벤치마크의 공식 출처(있으면) — 홈페이지/논문/코드/데이터/리더보드/저자/라이선스/인용/과제유형.
// BenchmarkOrigin(@assay/datasets)에서 옴(레시피/카탈로그가 채운 경우). 표시·인용용 메타.
export const DatasetOriginSchema = z.object({
  homepage: z.string().optional(),
  paper: z.string().optional(),
  code: z.string().optional(),
  data: z.string().optional(),
  leaderboard: z.string().optional(),
  authors: z.string().optional(),
  license: z.string().optional(),
  citation: z.string().optional(),
  taskType: z.string().optional(),
});
export type DatasetOrigin = z.infer<typeof DatasetOriginSchema>;

// 데이터셋 출처 — 어떻게 만들어졌나(등록된 레시피 / 카탈로그 / 인라인 spec) + 원본 데이터 출처(리니지) + 공식 provenance.
// via/id/version = 역참조(데이터셋 → 만든 레시피); source/origin = 리니지(데이터가 어디서·어떤 벤치마크인지).
export const DatasetProvenanceSchema = z.object({
  via: z.enum(["recipe", "catalog", "spec"]),
  id: z.string(), // recipe id | catalog id | 인라인 spec id
  version: z.string().optional(), // recipe 버전(있으면) — 상세 역링크의 정확한 버전
  source: DatasetSourceRefSchema.optional(), // 원본 데이터 출처(HF 등) — 인입 시점에 각인
  origin: DatasetOriginSchema.optional(), // 공식 벤치마크 provenance(레시피/카탈로그가 제공한 경우)
});
export type DatasetProvenance = z.infer<typeof DatasetProvenanceSchema>;

export const DatasetSchema = z.object({
  id: z.string(),
  version: z.string(),
  description: z.string().optional(),
  cases: z.array(EvalCaseSchema),
  tags: z.array(z.string()).default([]),
  producedBy: DatasetProvenanceSchema.optional(), // 인입 출처(있으면). 과거 데이터셋은 미설정.
});
export type Dataset = z.infer<typeof DatasetSchema>;

// 버전 간 diff — 한 필드의 before/after(표시용 문자열). 케이스 필드(task/env/graders/…)와
// 데이터셋 메타(description/tags) 변화를 같은 모양으로 표현한다.
export const DatasetFieldChangeSchema = z.object({
  field: z.string(),
  before: z.string(),
  after: z.string(),
});
export type DatasetFieldChange = z.infer<typeof DatasetFieldChangeSchema>;

// 케이스 참조(추가/삭제 표시용 경량) — id + task 만.
export const DatasetCaseRefSchema = z.object({ id: z.string(), task: z.string() });

// 두 데이터셋 버전(base↔candidate)의 구조적 diff — 케이스 단위 추가/삭제/변경 + 데이터셋 메타 변경.
// 불변 버전 전제: 같은 id 의 두 버전을 케이스 id 로 매칭해 무엇이 달라졌는지 보고한다(재현 가능 비교의 토대).
export const DatasetDiffSchema = z.object({
  id: z.string(),
  base: z.string(), // 해석된 base 버전(예: "1.0.0")
  candidate: z.string(), // 해석된 candidate 버전
  meta: z.array(DatasetFieldChangeSchema), // 데이터셋 단위: description / tags
  added: z.array(DatasetCaseRefSchema), // candidate 에만 있는 케이스
  removed: z.array(DatasetCaseRefSchema), // base 에만 있는 케이스
  changed: z.array(z.object({ id: z.string(), changes: z.array(DatasetFieldChangeSchema) })),
  unchanged: z.number().int(), // 동일한 케이스 개수
  summary: z.object({
    added: z.number().int(),
    removed: z.number().int(),
    changed: z.number().int(),
    unchanged: z.number().int(),
  }),
});
export type DatasetDiff = z.infer<typeof DatasetDiffSchema>;
