import { z } from 'zod'

// A judge model binding — a registered-Model reference ({ref, version?}) whose connection resolves at judge-run time,
// or a raw model string. Mirrors the control plane's ModelBinding (the same shape a harness / registered judge uses).
export const judgeModelBindingSchema = z.union([
  z.string(),
  z.object({ ref: z.string(), version: z.string().optional() }).passthrough(),
])
export type JudgeModelBinding = z.infer<typeof judgeModelBindingSchema>

// The workspace default judge model — scores inline judge graders when a run/scorecard selects no explicit judge.
export const workspaceJudgeSchema = z.object({
  provider: z.enum(['openai', 'anthropic']).optional(), // fallback provider for a raw-string model; a ref derives it from the Model
  model: judgeModelBindingSchema,
})
export type WorkspaceJudge = z.infer<typeof workspaceJudgeSchema>

// GET /workspace/settings — workspace policy (metering + default judge). Other keys pass through (defensive display view).
export const workspaceSettingsSchema = z
  .object({
    meterUsage: z.boolean().optional(),
    judge: workspaceJudgeSchema.optional(),
  })
  .passthrough()
export type WorkspaceSettings = z.infer<typeof workspaceSettingsSchema>

// The label/prefill value for a default judge: a ref → its registered-Model id; a raw string → the string; unset → ''.
export function defaultJudgeModelValue(judge: WorkspaceJudge | undefined): string {
  if (!judge) return ''
  return typeof judge.model === 'string' ? judge.model : judge.model.ref
}
