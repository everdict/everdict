import type {
  WorkflowStateColor as WireWorkflowStateColor,
  WorkflowStateRecord as WireWorkflowStateRecord,
} from '@everdict/contracts'
import { z } from 'zod'

import { issueStatusSchema } from '@/entities/issue'

// A team's workflow states — the names a team attached to the slots of its own workflow (docs/tracker.md).
// The canonical vocabulary (`status`) is CLOSED and a state is a "named view" over it: which is why renaming a column leaves the release gate,
// the rollups and regression watching entirely unaffected.
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
