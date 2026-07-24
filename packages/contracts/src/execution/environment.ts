import { z } from "zod";
import type { ComputeHandle } from "./compute.js";

// v1 is repo only. browser/os-use add variants to the union (no core rewrite).
export const RepoSnapshotSchema = z.object({
  kind: z.literal("repo"),
  diff: z.string(),
  changedFiles: z.array(z.string()),
  headSha: z.string(),
});
export type RepoSnapshot = z.infer<typeof RepoSnapshotSchema>;

// Result observation of a browser target environment (DOM/screenshot/URL). screenshotRef = MinIO object ref.
export const BrowserSnapshotSchema = z.object({
  kind: z.literal("browser"),
  url: z.string(),
  dom: z.string(),
  screenshotRef: z.string().optional(),
  // Embed the final page screenshot PNG as base64 (same shape as os-use) — input for a VLM judge (useScreenshot) + web inline display.
  // Reproduces how the official WebVoyager judges a screenshot with GPT-4V. If absent (not embedded), fall back to a text judge.
  screenshot: z.string().optional(),
  console: z.array(z.string()).default([]),
});
export type BrowserSnapshot = z.infer<typeof BrowserSnapshotSchema>;

// Environment-free QA (prompt→answer). There is no result world, so the snapshot is minimal (scoring looks at the answer in the trace — answer-match/judge).
export const PromptSnapshotSchema = z.object({
  kind: z.literal("prompt"),
  output: z.string().default(""), // optional: the agent's final answer (if any). The primary signal is the trace.
});
export type PromptSnapshot = z.infer<typeof PromptSnapshotSchema>;

// Result observation of desktop (OS) computer-use — screen screenshot + window list (OSWorld-style, desktop app automation). Input for a VLM judge.
export const OsUseSnapshotSchema = z.object({
  kind: z.literal("os-use"),
  screenshotRef: z.string().default(""), // path/ref of the captured screenshot (inside the image compute)
  // Embed the screenshot PNG as base64 (the carrier for taking it out of the result, since the compute is disposed). Display (web <img>) + VLM judge input.
  // Dev path: inline in the result record. At scale, offload to object storage (MinIO) + replace with a presigned URL (screenshotRef).
  screenshot: z.string().default(""), // base64 PNG (empty string if absent)
  windows: z.array(z.string()).default([]), // titles of visible windows (if any)
});
export type OsUseSnapshot = z.infer<typeof OsUseSnapshotSchema>;

export const EnvSnapshotSchema = z.discriminatedUnion("kind", [
  RepoSnapshotSchema,
  BrowserSnapshotSchema,
  PromptSnapshotSchema,
  OsUseSnapshotSchema,
]);
export type EnvSnapshot = z.infer<typeof EnvSnapshotSchema>;

// Repo seed source: remote git / inline file map (fixture) / in-image path (a repo already checked out in the container, e.g. SWE-bench /testbed).
// path: use the repo in the image as the working directory without cloning (deps also bundled in the image) — the coding agent works directly on that repo.
export const RepoSourceSchema = z.union([
  // Remote git: as-is if public; if private, reference a workspace external account connection (Connected accounts) by connectionId —
  // the control plane resolves that token at dispatch and loads it transiently into the job (CaseJob.repoToken) for authenticated clone (the token is not stored on the case).
  z.object({ git: z.string().url(), ref: z.string(), connectionId: z.string().optional() }),
  z.object({ files: z.record(z.string()) }),
  z.object({ path: z.string() }),
]);
export type RepoSource = z.infer<typeof RepoSourceSchema>;

export const EnvSpecSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("repo"),
    source: RepoSourceSchema,
    setup: z.array(z.string()).optional(),
  }),
  // Target environment (II): browser. Case seed = start URL. The actual instance is spun up per-case by the TopologyRuntime.
  z.object({
    kind: z.literal("browser"),
    startUrl: z.string().optional(),
  }),
  // Environment-free QA (prompt→answer). No stage like repo/browser — gsm8k/GAIA style. Adds optional context to the task.
  z.object({
    kind: z.literal("prompt"),
    context: z.string().optional(),
  }),
  // Target environment: desktop (OS). The agent looks at the screen and drives GUI apps with mouse/keyboard (OSWorld/computer-use, e.g. hermes-desktop).
  // Runs in a desktop compute image (Xvfb+apps) — setup brings up display/apps, screenshotCmd observes.
  z.object({
    kind: z.literal("os-use"),
    display: z.string().optional(), // X DISPLAY (default ":99")
    setup: z.array(z.string()).optional(), // commands to bring up display/window-manager/apps (Xvfb, wm, desktop app)
    screenshotCmd: z.string().optional(), // screenshot capture command (default scrot). Output path = screenshotPath
    screenshotPath: z.string().optional(), // screenshot save path (default /tmp/everdict-screen.png)
  }),
]);
export type EnvSpec = z.infer<typeof EnvSpecSchema>;

// The stage for behavior. seed = a known initial state, snapshot = capture the result world.
export interface Environment<S extends EnvSnapshot = EnvSnapshot> {
  readonly kind: S["kind"];
  seed(compute: ComputeHandle, spec: EnvSpec): Promise<void>;
  snapshot(compute: ComputeHandle): Promise<S>;
  // Optional in-run environment sample — the recorder plane, polled by run-case into CaseResult.envDeltas so a run's
  // replay shows how the world evolved (not just the final snapshot). Must be NON-INTRUSIVE (never mutate the agent's
  // state): RepoEnvironment returns a git-diff vs HEAD via a throwaway index. Absent = only the final snapshot is
  // captured. Best-effort — a sampling failure never affects the run. docs/architecture/replay.md (Principle 1).
  sampleDelta?(compute: ComputeHandle): Promise<{ kind: "repo-diff"; text: string } | undefined>;
}
