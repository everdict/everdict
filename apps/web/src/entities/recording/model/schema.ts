import type { CaseRecording } from '@everdict/contracts'
import { z } from 'zod'

// Replay recording — a deliberately-loose consumer view of the control plane's CaseRecording (like run.result):
// the UI reads the track lanes it renders (frames/logs) defensively and passes the rest through, so it survives
// server-side track additions. The flat fields are drift-guarded against the contract below.
const frameSchema = z.object({ t: z.number(), ref: z.string(), hash: z.string().optional() })
const logEntrySchema = z.object({ t: z.number(), stream: z.string(), text: z.string() })

export const recordingSchema = z.object({
  runId: z.string(),
  t0: z.number(),
  envKind: z.string(),
  effectiveFidelity: z.string(),
  tracks: z
    .object({
      frames: z.array(frameSchema).optional(),
      logs: z.array(logEntrySchema).optional(),
    })
    .passthrough(),
})
export type Recording = z.infer<typeof recordingSchema>
export type RecordingFrame = z.infer<typeof frameSchema>
export type RecordingLog = z.infer<typeof logEntrySchema>

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
