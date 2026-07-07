import { z } from "zod";

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

// An isolated execution unit. Extended with `computer?: Computer` (screenshot/click/type) at the OS-use stage.
export interface ComputeHandle {
  exec(cmd: string, opts?: ExecOpts): Promise<ExecResult>;
  writeFile(path: string, data: string): Promise<void>;
  readFile(path: string): Promise<string>;
  dispose(): Promise<void>;
}

// In-sandbox compute. Implementation: LocalDriver (dev / inside the agent).
// The actual isolation/placement is the Backend's job (Nomad/K8s/Windows) — not the Driver's.
export interface Driver {
  readonly id: string;
  provision(spec: ComputeSpec): Promise<ComputeHandle>;
}
