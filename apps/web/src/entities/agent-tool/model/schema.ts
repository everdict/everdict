import type {
  AgentModelPreferenceResponse as ContractAgentModelPreference,
  AgentToolDetailResponse as ContractAgentToolDetail,
  AgentToolEntry as ContractAgentToolEntry,
  AgentToolFunction as ContractAgentToolFunction,
  AgentToolProbeResponse as ContractAgentToolProbe,
} from '@everdict/contracts/wire'
import { z } from 'zod'

// An agent tool — one row of "the tools this workspace's assistant can use", seen from the signed-in member's point of view.
// The workspace AgentSpec is the shared baseline, and each member lays their own on/off over it (enabled).
// Boundary validation lives only in this zod v4, and the EXPORTED types are pinned to @everdict/contracts (P4). `import type` only.

// Where the tool came from — one-to-one with the list's three sections.
export const agentToolScopeSchema = z.enum(['builtin', 'workspace', 'personal'])
export type AgentToolScope = z.infer<typeof agentToolScopeSchema>

export const agentToolEntrySchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string(),
  type: z.enum(['mcp', 'code']),
  scope: agentToolScopeSchema,
  enabled: z.boolean(), // the final state as it applies to ME
  baseline: z.boolean(), // the workspace default — differing from `enabled` means "I changed it"
  writes: z.boolean(),
  requiredSecrets: z.array(z.string()),
  missingSecrets: z.array(z.string()),
  source: z.string().optional(),
  version: z.string().optional(),
  shadowedBy: z.string().optional(),
})
export type AgentToolEntry = z.infer<typeof agentToolEntrySchema>

export const agentToolListSchema = z.object({ tools: z.array(agentToolEntrySchema) })
export type AgentToolList = z.infer<typeof agentToolListSchema>

// ── Detail ───────────────────────────────────────────────────────────────────────────────────────
// Where a list row is "should I turn it on", the detail is "what IS it": how it is reached, what function it puts in front of the model,
// what description the model reads, which secrets it needs, and whether those resolve for me.

// The name the model actually calls is the NAMESPACED bridgedName (not the store name) — the runtime prefixes it so two servers cannot
// collide on a name.
export const agentToolFunctionSchema = z.object({
  name: z.string(),
  bridgedName: z.string(),
  description: z.string(),
  parametersSchema: z.record(z.string(), z.unknown()).optional(),
  readOnly: z.boolean(),
})
export type AgentToolFunction = z.infer<typeof agentToolFunctionSchema>

// How the runtime reaches this tool — a remote MCP session, a stdio container, or a code script.
export const agentToolTransportSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('http'), url: z.string() }),
  z.object({ kind: z.literal('stdio'), image: z.string(), args: z.array(z.string()) }),
  z.object({
    kind: z.literal('code'),
    language: z.enum(['python', 'node']),
    timeoutSec: z.number().optional(),
    image: z.string().optional(),
  }),
])
export type AgentToolTransport = z.infer<typeof agentToolTransportSchema>

// One declared secret seen from MY point of view — the logical name the tool calls it, the secret name actually read, and whether I have it.
export const agentToolSecretSchema = z.object({
  name: z.string(),
  description: z.string(),
  boundTo: z.string(),
  resolved: z.boolean(),
})
export type AgentToolSecret = z.infer<typeof agentToolSecretSchema>

export const agentToolExampleSchema = z.object({
  name: z.string().optional(),
  input: z.record(z.string(), z.unknown()),
  note: z.string().optional(),
})

export const agentToolDetailSchema = agentToolEntrySchema.extend({
  origin: z.enum(['builtin', 'capability', 'mcpServer']),
  transport: agentToolTransportSchema,
  functions: z.array(agentToolFunctionSchema),
  secrets: z.array(agentToolSecretSchema),
  code: z.string().optional(), // a code tool's pinned source — so what executes can be audited
  parametersSchema: z.record(z.string(), z.unknown()).optional(),
  examples: z.array(agentToolExampleSchema),
  capability: z.object({ source: z.string(), id: z.string(), version: z.string() }).optional(),
  tags: z.array(z.string()),
  bindable: z.boolean(), // can the secret binding be changed here (an adopted capability · a hand-wired MCP server)
  editable: z.boolean(), // can it be edited by conversation and version-stamped (only a capability THIS workspace owns)
  probeable: z.boolean(), // is a connection test meaningful (remote HTTP MCP only)
})
export type AgentToolDetail = z.infer<typeof agentToolDetailSchema>

export const agentToolProbeSchema = z.object({
  reachable: z.boolean(),
  detail: z.string(),
  reason: z.enum(['auth', 'unreachable', 'protocol']).optional(),
  functions: z.array(agentToolFunctionSchema),
  missingSecrets: z.array(z.string()),
})
export type AgentToolProbe = z.infer<typeof agentToolProbeSchema>

// ── My default model ─────────────────────────────────────────────────────────────────────────────
// The third channel of the same overlay. Where tools and skills are "what my agent USES", this is "what it THINKS with".
// model=null means following the workspace baseline (AgentSpec.model → the server default), which is why the read carries that baseline
// along — a default only means something beside the value it stands in for.
export const agentModelPreferenceSchema = z.object({
  model: z.string().nullable(),
  workspaceDefault: z.string().nullable(),
})
export type AgentModelPreference = z.infer<typeof agentModelPreferenceSchema>

// The drift guard — a change to the contract wire type breaks the web typecheck (in both directions).
type AssertAssignable<A extends B, B> = A
type _Fwd = AssertAssignable<AgentToolEntry, ContractAgentToolEntry>
type _Back = AssertAssignable<ContractAgentToolEntry, AgentToolEntry>
type _FnFwd = AssertAssignable<AgentToolFunction, ContractAgentToolFunction>
type _DetailFwd = AssertAssignable<AgentToolDetail, ContractAgentToolDetail>
type _ProbeFwd = AssertAssignable<AgentToolProbe, ContractAgentToolProbe>
type _ModelFwd = AssertAssignable<AgentModelPreference, ContractAgentModelPreference>
type _ModelBack = AssertAssignable<ContractAgentModelPreference, AgentModelPreference>
