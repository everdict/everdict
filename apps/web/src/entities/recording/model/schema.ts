import type { CaseRecording } from '@everdict/contracts'
import { z } from 'zod'

// Replay recording — a deliberately-loose consumer view of the control plane's CaseRecording (like run.result):
// the UI reads the track lanes it renders (frames/logs) defensively and passes the rest through, so it survives
// server-side track additions. The flat fields are drift-guarded against the contract below.
const frameSchema = z.object({ t: z.number(), ref: z.string(), hash: z.string().optional() })
const logEntrySchema = z.object({ t: z.number(), stream: z.string(), text: z.string() })
// ② environment plane — the world the agent acted on, captured at its OWN layer (browser CDP): the request track,
// console messages, and navigation history over time. These are what makes a browser-use replay show "how the page
// changed", not just the agent's decisions. docs/architecture/replay.md (Principle 2/3).
const netEntrySchema = z.object({
  t: z.number(),
  method: z.string(),
  url: z.string(),
  status: z.number().optional(),
  ms: z.number().optional(),
  bodyRef: z.string().optional(),
})
const consoleEntrySchema = z.object({ t: z.number(), level: z.string(), text: z.string() })
const navEntrySchema = z.object({ t: z.number(), url: z.string() })
// ③ runtime/system plane — the sandbox itself sampled over time (CPU/mem/net I/O + lifecycle markers). The only plane
// that answers "did it OOM / thrash", invisible to both the agent trace and the environment DOM.
const runtimeSampleSchema = z.object({
  t: z.number(),
  cpuPct: z.number().optional(),
  memBytes: z.number().optional(),
  rxBytes: z.number().optional(),
  txBytes: z.number().optional(),
  event: z.string().optional(),
})
// Open-vocabulary lane — carries in-run environment deltas (name="repo-diff", text=git diff) folded in at seal, plus
// any future producer's custom track. The player renders known names (repo-diff) specially, unknown ones generically.
const customEntrySchema = z.object({
  t: z.number(),
  name: z.string(),
  ref: z.string().optional(),
  text: z.string().optional(),
})

export const recordingSchema = z.object({
  runId: z.string(),
  t0: z.number(),
  envKind: z.string(),
  effectiveFidelity: z.string(),
  tracks: z
    .object({
      frames: z.array(frameSchema).optional(),
      logs: z.array(logEntrySchema).optional(),
      network: z.array(netEntrySchema).optional(),
      console: z.array(consoleEntrySchema).optional(),
      nav: z.array(navEntrySchema).optional(),
      runtime: z.array(runtimeSampleSchema).optional(),
      custom: z.array(customEntrySchema).optional(),
    })
    .passthrough(),
})
export type Recording = z.infer<typeof recordingSchema>
export type RecordingFrame = z.infer<typeof frameSchema>
export type RecordingLog = z.infer<typeof logEntrySchema>
export type RecordingNet = z.infer<typeof netEntrySchema>
export type RecordingConsole = z.infer<typeof consoleEntrySchema>
export type RecordingNav = z.infer<typeof navEntrySchema>
export type RecordingRuntime = z.infer<typeof runtimeSampleSchema>
export type RecordingCustom = z.infer<typeof customEntrySchema>

export const recordingResponseSchema = z.object({
  status: z.string(),
  found: z.boolean(),
  recording: recordingSchema.nullable(),
})

// Drift guard — the flat recording fields must stay assignable FROM the contract (a wire rename/retype breaks the
// web typecheck); the tracks stay a deliberately-loose consumer view (read by lane), like run.result.
type AssertAssignable<A extends B, B> = A
type _recordingFlat = AssertAssignable<
  Pick<CaseRecording, 'runId' | 't0' | 'envKind' | 'effectiveFidelity'>,
  Pick<Recording, 'runId' | 't0' | 'envKind' | 'effectiveFidelity'>
>
export type __recordingDriftGuard = [_recordingFlat]
