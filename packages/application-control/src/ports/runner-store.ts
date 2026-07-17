import type { PairRunnerInput, PairedRunner, ResolvedRunner, RunnerMeta } from "@everdict/contracts";

export interface RunnerStore {
  pair(input: PairRunnerInput): Promise<PairedRunner>;
  list(owner: string): Promise<RunnerMeta[]>; // personal (owner) meta only
  get(owner: string, id: string): Promise<RunnerMeta | null>; // owner-scoped single record (ownership check — dispatch self: routing)
  listByWorkspace(workspace: string): Promise<RunnerMeta[]>; // workspace roster (meta only)
  remove(owner: string, id: string): Promise<void>; // owner-scoped, idempotent
  touch(owner: string, id: string): Promise<void>; // refresh lastSeenAt (idempotent; no-op for a missing runner)
  setCapabilities(owner: string, id: string, capabilities: string[]): Promise<void>; // runner self-advertise (docker etc.). Idempotent; no-op for a missing runner
  setOs(owner: string, id: string, os: string): Promise<void>; // runner self-report its OS (process.platform) on lease. Idempotent; no-op for a missing runner
  setVersion(owner: string, id: string, version: string, protocol: number): Promise<void>; // runner self-report its build/protocol version on lease. Idempotent; no-op for a missing runner
  resolveByToken(token: string): Promise<ResolvedRunner | null>; // resolve a runner by token hash (internal only)
}
