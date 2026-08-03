import type {
  IssueLabelColor as WireIssueLabelColor,
  IssueLabelRecord as WireIssueLabelRecord,
} from '@everdict/contracts'
import { z } from 'zod'

// The workspace's label registry (docs/tracker.md). An issue carries `labelIds`; a chip is drawn by joining
// against this list — the same join the pages already do for members and projects.

export const ISSUE_LABEL_COLORS = [
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
export const issueLabelColorSchema = z.enum(ISSUE_LABEL_COLORS)
export type IssueLabelColor = z.infer<typeof issueLabelColorSchema>

export const issueLabelSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  name: z.string(),
  color: issueLabelColorSchema,
  description: z.string().optional(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type IssueLabel = z.infer<typeof issueLabelSchema>

export const issueLabelsSchema = z.array(issueLabelSchema)

// Compile-time drift guard (rules/web.md): the local schema is bound to the contract type in both directions,
// so a wire rename or retype fails the web typecheck instead of surfacing as a runtime parse error.
type AssertAssignable<A extends B, B> = A
type _colorFwd = AssertAssignable<IssueLabelColor, WireIssueLabelColor>
type _colorBack = AssertAssignable<WireIssueLabelColor, IssueLabelColor>
type _labelFwd = AssertAssignable<IssueLabel, WireIssueLabelRecord>
type _labelBack = AssertAssignable<WireIssueLabelRecord, IssueLabel>

// id → label, for the chip join. Built once per page render.
export function issueLabelDirectoryOf(labels: IssueLabel[]): Record<string, IssueLabel> {
  return Object.fromEntries(labels.map((l) => [l.id, l]))
}
