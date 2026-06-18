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
