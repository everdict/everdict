import { z } from "zod";
import { EvalCaseSchema } from "./eval-case.js";

// 데이터셋: eval 케이스 묶음 — 하니스 무관(어느 하니스@버전이든 같은 케이스로 돌려 공정 비교).
// 버전 불변(레지스트리가 강제) — baseline↔candidate 비교가 재현 가능하려면 케이스가 고정돼야 한다.
// core 의 Suite 와 구분: Suite 는 harness.id 에 묶이고 비버전, Dataset 은 하니스 무관 + 버전 관리.
export const DatasetSchema = z.object({
  id: z.string(),
  version: z.string(),
  description: z.string().optional(),
  cases: z.array(EvalCaseSchema),
  tags: z.array(z.string()).default([]),
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
