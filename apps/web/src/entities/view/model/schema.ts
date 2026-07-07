import { z } from 'zod'

// 컨트롤플레인 "저장된 스코어카드 분석 View" 의 클라이언트 미러. 웹은 HTTP 로만 결합 — @everdict/* 비의존.
// config 는 웹 AnalysisConfig(recipe) — 여기선 불투명(웹이 형태 검증). 스냅샷 아님: 열 때 현재 데이터로 재실행(라이브).
export const viewVisibilitySchema = z.enum(['private', 'workspace'])
export type ViewVisibility = z.infer<typeof viewVisibilitySchema>

export const viewSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  name: z.string(),
  config: z.unknown(), // 웹 AnalysisConfig — paramsToConfig 와 대응(불투명 저장).
  visibility: viewVisibilitySchema,
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type View = z.infer<typeof viewSchema>
export const viewsSchema = z.array(viewSchema)
