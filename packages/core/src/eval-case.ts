import { z } from "zod";
import { EnvSnapshotSchema, EnvSpecSchema } from "./environment.js";
import { ScoreSchema } from "./grader.js";
import { TraceEventSchema } from "./trace.js";

// 그레이더 지정: id + 선택적 config (예: tests-pass 의 { cmd }).
// 에이전트가 이 스펙으로부터 Grader 인스턴스를 재구성한다.
export const GraderSpecSchema = z.object({
  id: z.string(),
  config: z.record(z.unknown()).optional(),
});
export type GraderSpec = z.infer<typeof GraderSpecSchema>;

// 배치(placement) 힌트 — 컨트롤플레인 라우터가 어느 백엔드로 보낼지 결정할 때 본다.
// 에이전트는 이 필드를 무시한다(실행 위치는 에이전트의 관심사가 아니다).
export const PlacementSchema = z.object({
  target: z.string().optional(), // 등록된 백엔드 이름 (예: "nomad-seoul")
  os: z.enum(["linux", "windows", "macos"]).optional(),
  isolation: z.string().optional(), // 예: "gvisor"
});
export type Placement = z.infer<typeof PlacementSchema>;

export const EvalCaseSchema = z.object({
  id: z.string(),
  env: EnvSpecSchema,
  task: z.string(),
  graders: z.array(GraderSpecSchema),
  image: z.string().optional(),
  timeoutSec: z.number().default(1800),
  tags: z.array(z.string()).default([]),
  placement: PlacementSchema.optional(),
});
export type EvalCase = z.infer<typeof EvalCaseSchema>;

// 실행 출처(프로비넌스) — 컨트롤플레인이 스탬프(러너 자기보고 아님). 셀프호스티드 러너처럼 "비관리 호스트"에서
// 돈 결과를 워크스페이스가 식별/신뢰가중하도록. 기본(관리형 백엔드)은 미설정.
export const CaseProvenanceSchema = z.object({
  ranOn: z.string(), // 예: "self-hosted"
  runner: z.string().optional(), // 러너 id(디바이스)
  by: z.string().optional(), // 실행한 주체(principal.subject)
});
export type CaseProvenance = z.infer<typeof CaseProvenanceSchema>;

export const CaseResultSchema = z.object({
  caseId: z.string(),
  harness: z.string(), // "claude-code@1.2.3"
  trace: z.array(TraceEventSchema),
  snapshot: EnvSnapshotSchema,
  scores: z.array(ScoreSchema),
  provenance: CaseProvenanceSchema.optional(), // 셀프호스티드 등 비관리 실행의 출처(컨트롤플레인 스탬프)
});
export type CaseResult = z.infer<typeof CaseResultSchema>;

export const ScorecardSchema = z.object({
  suiteId: z.string(),
  harness: z.string(),
  results: z.array(CaseResultSchema),
});
export type Scorecard = z.infer<typeof ScorecardSchema>;
