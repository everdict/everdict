import { z } from "zod";
import { FsPathSchema } from "../records/workspace-file.js";

// Running ONE file from the workspace filesystem — the viewer's "Run", not an eval. A run is a short-lived,
// isolated sandbox that gets the file, executes it with the interpreter its extension implies, and hands back
// what it printed plus whatever files it produced. Deliberately NOT a CaseJob: no harness, no grading, no run
// record — the eval spine stays the eval spine, and this stays a tool for the person reading the file.
//
// Isolation is the Driver's container, never the control-plane process; the service refuses to run at all when
// no driver is composed (`EVERDICT_FILE_EXECUTION_DRIVER`).

export const FILE_EXECUTION_DEFAULT_TIMEOUT_SEC = 60;
export const FILE_EXECUTION_MAX_TIMEOUT_SEC = 300;
export const FILE_EXECUTION_MAX_OUTPUT_CHARS = 100_000; // per stream; beyond this the tail is dropped and flagged
export const FILE_EXECUTION_MAX_PRODUCED_FILES = 10;

export const FileExecutionRequestSchema = z.object({
  path: FsPathSchema,
  // Override the language's default image — normally a workspace environment image, so a script runs against the
  // same dependencies an eval case would get.
  image: z.string().min(1).max(512).optional(),
  timeoutSec: z.number().int().min(1).max(FILE_EXECUTION_MAX_TIMEOUT_SEC).optional(),
});
export type FileExecutionRequest = z.infer<typeof FileExecutionRequestSchema>;

// A file the script wrote into its working directory, carried back into the workspace tree next to the script.
export const FileExecutionOutputSchema = z.object({
  path: z.string(), // where it landed in the workspace filesystem
  name: z.string(), // its name inside the sandbox
  size: z.number().int().nonnegative(),
  skipped: z.boolean().optional(), // a file already existed at that path — never overwritten by a run
});
export type FileExecutionOutput = z.infer<typeof FileExecutionOutputSchema>;

export const FileExecutionResultSchema = z.object({
  path: z.string(),
  image: z.string(),
  command: z.string(), // exactly what ran inside the sandbox — the run is reproducible by hand
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(), // either stream hit FILE_EXECUTION_MAX_OUTPUT_CHARS
  timedOut: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  outputs: z.array(FileExecutionOutputSchema),
});
export type FileExecutionResult = z.infer<typeof FileExecutionResultSchema>;
