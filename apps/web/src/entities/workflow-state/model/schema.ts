import type {
  WorkflowStateColor as WireWorkflowStateColor,
  WorkflowStateRecord as WireWorkflowStateRecord,
} from '@everdict/contracts'
import { z } from 'zod'

import { issueStatusSchema } from '@/entities/issue'

// 팀의 워크플로 상태 — 팀이 자기 워크플로의 자리들에 붙인 이름(docs/tracker.md).
// 정규 어휘(`status`)는 닫혀 있고, 상태는 그 위의 "이름 붙은 뷰"다: 그래서 컬럼 이름을 바꿔도 릴리스 게이트·
// 롤업·회귀 감시는 아무 영향을 받지 않는다.
export const WORKFLOW_STATE_COLORS = [
  'gray',
  'purple',
  'blue',
  'teal',
  'green',
  'yellow',
  'orange',
  'red',
  'pink',
] as const
export const workflowStateColorSchema = z.enum(WORKFLOW_STATE_COLORS)

export const workflowStateSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  teamId: z.string(),
  name: z.string(),
  description: z.string().optional(),
  status: issueStatusSchema,
  color: workflowStateColorSchema,
  position: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export const workflowStatesSchema = z.array(workflowStateSchema)

type AssertAssignable<A extends B, B> = A
type WebWorkflowState = z.infer<typeof workflowStateSchema>
type _stateFwd = AssertAssignable<WebWorkflowState, WireWorkflowStateRecord>
type _stateBack = AssertAssignable<WireWorkflowStateRecord, WebWorkflowState>
type _colorFwd = AssertAssignable<z.infer<typeof workflowStateColorSchema>, WireWorkflowStateColor>
type _colorBack = AssertAssignable<WireWorkflowStateColor, z.infer<typeof workflowStateColorSchema>>

export type WorkflowState = WireWorkflowStateRecord
export type WorkflowStateColor = WireWorkflowStateColor
export type __workflowStateDriftGuard = [_stateFwd, _stateBack, _colorFwd, _colorBack]
