import type { AgentSkillEntry as ContractAgentSkillEntry } from '@everdict/contracts/wire'
import { z } from 'zod'

// An agent skill — one row of "the procedures this workspace supports", seen from the signed-in member's point of view.
// The workspace skill library (the Skill records the workspace owns — hand-written ones plus copies imported from the store) is the
// baseline, and each member lays their own on/off over it.
// Boundary validation lives only in this zod v4, and the EXPORTED types are pinned to @everdict/contracts (P4). `import type` only.
import { agentToolScopeSchema } from '@/entities/agent-tool'

export const agentSkillEntrySchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string(),
  scope: agentToolScopeSchema,
  enabled: z.boolean(), // the final state as it applies to ME
  baseline: z.boolean(), // the workspace default — differing from `enabled` means "I changed it"
  version: z.string().optional(),
  shadowedBy: z.string().optional(),
})
export type AgentSkillEntry = z.infer<typeof agentSkillEntrySchema>

export const agentSkillListSchema = z.object({ skills: z.array(agentSkillEntrySchema) })
export type AgentSkillList = z.infer<typeof agentSkillListSchema>

// The drift guard — a change to the contract wire type breaks the web typecheck (in both directions).
type AssertAssignable<A extends B, B> = A
type _Fwd = AssertAssignable<AgentSkillEntry, ContractAgentSkillEntry>
type _Back = AssertAssignable<ContractAgentSkillEntry, AgentSkillEntry>
