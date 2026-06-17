import { z } from "zod";
import { EvalCaseSchema } from "./eval-case.js";

// 스위트: 한 하니스(id)에 대해 돌릴 케이스 묶음. 버전은 실행 시 지정한다(같은 스위트로 v간 비교).
export const SuiteSchema = z.object({
  id: z.string(),
  harness: z.object({ id: z.string() }),
  cases: z.array(EvalCaseSchema),
});
export type Suite = z.infer<typeof SuiteSchema>;
