import type { Router } from "@assay/backends";
import type { AgentJob, CaseResult } from "@assay/core";
import type { Activities } from "./types.js";

// 액티비티는 비결정적·I/O 허용 영역 — 여기서 실제 백엔드로 라우팅/디스패치한다.
// 워커가 보유한 Router(여러 백엔드 등록됨)를 클로저로 받는다.
export function createActivities(router: Router): Activities {
  return {
    dispatchCase(job: AgentJob): Promise<CaseResult> {
      return router.dispatch(job);
    },
  };
}
