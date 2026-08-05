import { z } from "zod";
import type { RegistryAuth } from "../infra/image-ref.js";

export const CapabilitySchema = z.enum(["shell", "browser", "desktop"]);
export type Capability = z.infer<typeof CapabilitySchema>;

export const ComputeSpecSchema = z.object({
  os: z.literal("linux"), // v1. windows/macos are extended in the Pool Driver.
  image: z.string().optional(),
  needs: z.array(CapabilitySchema).default(["shell"]),
  cpu: z.number().optional(),
  memMb: z.number().optional(),
});
export type ComputeSpec = z.infer<typeof ComputeSpecSchema>;

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ExecOpts {
  cwd?: string;
  timeoutSec?: number;
  env?: Record<string, string>;
}

// One incremental piece of a streaming exec's output, in arrival order per stream.
export interface ExecChunk {
  stream: "stdout" | "stderr";
  data: string;
}

// An isolated execution unit. Extended with `computer?: Computer` (screenshot/click/type) at the OS-use stage.
export interface ComputeHandle {
  // The driver-level identity of this compute (a container id), when the driver has one. Session runs
  // persist it on the row so a reaper in a LATER process can still tear the compute down (see Driver.reap).
  readonly id?: string;
  exec(cmd: string, opts?: ExecOpts): Promise<ExecResult>;
  // Streaming exec: the SAME result contract as exec (a non-zero exit resolves, a timeout resolves 124),
  // with output chunks ALSO delivered incrementally as they arrive. Optional so callers can DETECT support
  // and pick an incremental parse path (an ignored option flag would force fragile double-parse dedup);
  // absent = buffered only.
  execStream?(cmd: string, onChunk: (chunk: ExecChunk) => void, opts?: ExecOpts): Promise<ExecResult>;
  writeFile(path: string, data: string): Promise<void>;
  readFile(path: string): Promise<string>;
  dispose(): Promise<void>;
}

// In-sandbox compute. Implementation: LocalDriver (dev / inside the agent).
// The actual isolation/placement is the Backend's job (Nomad/K8s/Windows) — not the Driver's.
export interface Driver {
  readonly id: string;
  provision(spec: ComputeSpec): Promise<ComputeHandle>;
  // Tear down a compute this process no longer holds a handle to, by its recorded id (P6: the durable
  // reaper after a crash — the row remembers the compute id, the driver knows how to remove it). Optional:
  // only drivers whose computes can outlive the process (docker) implement it.
  reap?(id: string): Promise<void>;
  // Capture a live compute's filesystem as an image and publish it to `ref` (agent worlds W1: the session
  // hibernate/snapshot primitive). Runs HOST-side — the credential never enters the compute, so it can never
  // end up inside the captured image. Optional: only drivers whose runtime can commit a container implement
  // it; callers detect support (absent = snapshots not available on this driver, a 400 not a crash).
  snapshot?(id: string, ref: string, auth?: RegistryAuth): Promise<void>;
}
