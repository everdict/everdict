import { z } from "zod";
import { type RegistryAuth, RegistryAuthSchema } from "../infra/image-ref.js";
import { NetworkPolicySchema, ResourceRequestSchema } from "../infra/world.js";

export const CapabilitySchema = z.enum(["shell", "browser", "desktop"]);
export type Capability = z.infer<typeof CapabilitySchema>;

export const ComputeSpecSchema = z.object({
  // The world the evaluation DECLARED it needs (case/harness placement.os) — not what the driver happens to
  // provide. A driver that cannot satisfy the declared os REFUSES before execution (a clear pre-flight error),
  // never silently substitutes linux: a windows case run on linux is a wrong-world result, not a result.
  os: z.enum(["linux", "windows", "macos"]),
  image: z.string().optional(),
  needs: z.array(CapabilitySchema).default(["shell"]),
  // The declared world (EvalCase.resources / EvalCase.network), carried to whoever provisions. These
  // replace a dead `cpu`/`memMb` pair that nothing ever filled and nothing ever read — and that used a
  // second spelling of the resource vocabulary the harness specs already had.
  //
  // A driver that cannot ENFORCE what is declared here refuses, exactly like `os` above. That is the whole
  // point of moving the declaration onto the case: a limit nobody applies is worse than no limit, because
  // the result carries the same shape either way and only one of them is true.
  resources: ResourceRequestSchema.optional(),
  network: NetworkPolicySchema.optional(),
  // Pull credentials for `image`, resolved per provision (the CaseJob.registryAuths twin for the driver lane:
  // a grant is short-lived, so it belongs to the call, not to a driver built once at boot). A driver that
  // authenticates pulls prefers these over its constructor-level ones.
  registryAuths: z.array(RegistryAuthSchema).optional(),
  // WHOSE compute this is. A driver that places on shared infrastructure resolves the tenant's trust zone
  // from it (namespace + isolation runtime); a host-local driver ignores it. Per provision rather than per
  // driver because one cluster driver serves every tenant.
  tenant: z.string().optional(),
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
