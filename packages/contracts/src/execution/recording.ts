import { z } from "zod";

// The depth ladder for what a recording captures, ascending: off < final < frames < semantic < full.
// A recorder clamps a requested rung to what its environment kind can actually produce (domain clampFidelity).
// docs/architecture/replay.md — "Recording planes & the fidelity ladder".
export const FidelitySchema = z.enum(["off", "final", "frames", "semantic", "full"]);
export type Fidelity = z.infer<typeof FidelitySchema>;

// --- Track entries: each is one timestamped datum on a plane's lane (t = wall-clock ms, shared t0 clock). ---

// ② environment plane
export const FrameEntrySchema = z.object({
  t: z.number(),
  ref: z.string(), // object-store PNG ref (offloaded; consecutive-identical frames may share a ref)
  hash: z.string().optional(),
});
export type FrameEntry = z.infer<typeof FrameEntrySchema>;

export const DomEventSchema = z.object({
  t: z.number(),
  ref: z.string(), // offloaded rrweb-style event batch (semantic web replay)
});
export type DomEvent = z.infer<typeof DomEventSchema>;

export const NetEntrySchema = z.object({
  t: z.number(),
  method: z.string(),
  url: z.string(),
  status: z.number().optional(),
  ms: z.number().optional(),
  bodyRef: z.string().optional(), // full request/response body only at `full` fidelity
});
export type NetEntry = z.infer<typeof NetEntrySchema>;

export const ConsoleEntrySchema = z.object({
  t: z.number(),
  level: z.string(),
  text: z.string(),
});
export type ConsoleEntry = z.infer<typeof ConsoleEntrySchema>;

export const NavEntrySchema = z.object({
  t: z.number(),
  url: z.string(),
});
export type NavEntry = z.infer<typeof NavEntrySchema>;

export const DeltaEntrySchema = z.object({
  t: z.number(),
  kind: z.enum(["dom", "repo-diff", "os-windows"]),
  ref: z.string(),
});
export type DeltaEntry = z.infer<typeof DeltaEntrySchema>;

// ② logs (distinct from the trace `log` event — this is the environment/job log lane over time)
export const RecordingLogEntrySchema = z.object({
  t: z.number(),
  stream: z.enum(["stdout", "stderr"]),
  text: z.string(),
});
export type RecordingLogEntry = z.infer<typeof RecordingLogEntrySchema>;

// ③ runtime/system plane
export const RuntimeSampleSchema = z.object({
  t: z.number(),
  cpuPct: z.number().optional(),
  memBytes: z.number().optional(),
  rxBytes: z.number().optional(),
  txBytes: z.number().optional(),
  event: z.string().optional(), // lifecycle marker (started/oom/killed/…)
});
export type RuntimeSample = z.infer<typeof RuntimeSampleSchema>;

// Open-vocabulary lane — a future environment kind's novel track (mobile touch, API-call log, …) with no contract change.
export const CustomEntrySchema = z.object({
  t: z.number(),
  name: z.string(),
  ref: z.string().optional(),
  text: z.string().optional(),
});
export type CustomEntry = z.infer<typeof CustomEntrySchema>;

// A single append into the recording, tagged by its track — the unit the RecordingSink carries.
export const TrackEntrySchema = z.discriminatedUnion("track", [
  z.object({ track: z.literal("frames"), entry: FrameEntrySchema }),
  z.object({ track: z.literal("domEvents"), entry: DomEventSchema }),
  z.object({ track: z.literal("network"), entry: NetEntrySchema }),
  z.object({ track: z.literal("console"), entry: ConsoleEntrySchema }),
  z.object({ track: z.literal("nav"), entry: NavEntrySchema }),
  z.object({ track: z.literal("stateDeltas"), entry: DeltaEntrySchema }),
  z.object({ track: z.literal("logs"), entry: RecordingLogEntrySchema }),
  z.object({ track: z.literal("runtime"), entry: RuntimeSampleSchema }),
  z.object({ track: z.literal("custom"), entry: CustomEntrySchema }),
]);
export type TrackEntry = z.infer<typeof TrackEntrySchema>;

// The resolved spec/model/seed/env a run was actually dispatched with — sealed into the recording so a run is
// self-describing for audit (extends origin/provenance; the pipeline widens it as it fills). docs/architecture/replay.md.
export const DispatchManifestSchema = z.object({
  harness: z.string(), // resolved "id@version"
  runtime: z.string().optional(),
  model: z.string().optional(),
  seed: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
});
export type DispatchManifest = z.infer<typeof DispatchManifestSchema>;

// A per-run recording: track lanes on one wall-clock (t0) timeline. Byte-heavy entries hold object-store refs, not bytes.
// The trace (agent plane) is NOT duplicated here — the player reads CaseResult.trace alongside this on the shared clock.
export const CaseRecordingSchema = z.object({
  runId: z.string(), // the CP-minted, record-derivable correlation key
  t0: z.number(), // wall-clock anchor (ms) — every track.t and trace.t share this clock
  tracks: z.object({
    frames: z.array(FrameEntrySchema).optional(),
    domEvents: z.array(DomEventSchema).optional(),
    network: z.array(NetEntrySchema).optional(),
    console: z.array(ConsoleEntrySchema).optional(),
    nav: z.array(NavEntrySchema).optional(),
    stateDeltas: z.array(DeltaEntrySchema).optional(),
    logs: z.array(RecordingLogEntrySchema).optional(),
    runtime: z.array(RuntimeSampleSchema).optional(),
    custom: z.array(CustomEntrySchema).optional(),
  }),
  envKind: z.string(), // which recorder adapter produced the env tracks
  effectiveFidelity: FidelitySchema, // what was ACTUALLY captured (clamped to capabilities), not what was asked
  dispatch: DispatchManifestSchema.optional(), // audit manifest (sealed at finalize)
});
export type CaseRecording = z.infer<typeof CaseRecordingSchema>;

// Rides on CaseResult / RunRecord, sibling of traceRef — an object-store pointer to the sealed CaseRecording, never bytes.
export const RecordingRefSchema = z.object({
  ref: z.string(),
});
export type RecordingRef = z.infer<typeof RecordingRefSchema>;

// --- Recorder seam (interfaces; impls live per environment kind in adapter packages). ---

export interface RecorderCapabilities {
  maxFidelity: Fidelity; // the highest rung this environment kind can produce
  tracks: string[]; // the track lanes it can emit
}

// Injected into a recorder — appends one entry to the durable recording (the RecordingStore.append, D4).
export interface RecordingSink {
  emit(item: TrackEntry): void;
}

// Per-environment-kind recorder: streams its tracks during a run at a clamped fidelity. Sibling of Environment.snapshot().
// The framework knows tracks, not kinds — a new environment plugs in one impl here (browser/repo/os-use/…; NullRecorder = prompt).
export interface EnvironmentRecorder {
  capabilities(): RecorderCapabilities;
  start(sink: RecordingSink, level: Fidelity): Promise<void>;
  checkpoint(reason: string): Promise<void>;
  stop(): Promise<void>;
}
