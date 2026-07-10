import { CapabilityNameSchema, type PairRunnerInput, type PairedRunner, type RunnerMeta } from "@everdict/contracts";
import { z } from "zod";
import type { RunnerStore } from "../ports/runner-store.js";

// Self-hosted runner service — the core of personally-owned device pairing (pair/list/revoke/workspace roster).
// Shared by the HTTP routes and the MCP tools (BFF↔MCP parity). The token is returned in plaintext only once at pair time (stored as a hash).
// Dispatch/lease (MCP lease/result) are later slices — this is personally-owned CRUD only. Design: docs/architecture/self-hosted-runner.md.

// What a runner can run — a tuple (.options) kept in sync with the core vocabulary (CapabilityNameSchema) SSOT. Serves as z.enum material and
// as the setCapabilities known-set (self-advertised values outside the vocabulary are dropped). It follows the core vocabulary automatically when it changes.
export const RUNNER_CAPABILITIES = CapabilityNameSchema.options;

// Pair request body (owner/workspace come from the Principal — not accepted in the body).
export const PairRunnerBodySchema = z.object({
  label: z.string().min(1).max(80),
  os: z.string().min(1).max(40).optional(),
  capabilities: z.array(CapabilityNameSchema).optional(),
});
export type PairRunnerBody = z.infer<typeof PairRunnerBodySchema>;

export class RunnerService {
  constructor(private readonly store: RunnerStore) {}
  // Personally-owned: owner=principal.subject. The plaintext token rides out in the result exactly once (stored as a hash).
  async pair(input: PairRunnerInput): Promise<PairedRunner> {
    return this.store.pair(input);
  }
  // Personally-owned — I see my runners from any workspace (self-scoped, same as profile/connections).
  async list(owner: string): Promise<RunnerMeta[]> {
    return this.store.list(owner);
  }
  async revoke(owner: string, id: string): Promise<void> {
    await this.store.remove(owner, id);
  }
  // Mark a runner as connected (update lastSeenAt on lease/heartbeat). No-op if the runner doesn't exist.
  async touch(owner: string, id: string): Promise<void> {
    await this.store.touch(owner, id);
  }
  // Runner self-advertisement — report actual capabilities (e.g. detected docker daemon) at lease time. Unknown values are dropped. No-op if the runner doesn't exist.
  async setCapabilities(owner: string, id: string, capabilities: string[]): Promise<void> {
    const known = new Set<string>(RUNNER_CAPABILITIES);
    await this.store.setCapabilities(owner, id, [...new Set(capabilities.filter((c) => known.has(c)))]);
  }
  // Workspace roster (read-only) — metadata for runners paired in this workspace (no tokens). For the settings > members tab.
  async listForWorkspace(workspace: string): Promise<RunnerMeta[]> {
    return this.store.listByWorkspace(workspace);
  }

  // Workspace-shared runner (team resource) — owner="ws:<workspace>". Unlike a personal runner (owner=subject), an admin registers it and
  // any member of this workspace targets it (self:ws:<id>). Billing is the workspace's (not personal own-pays — later). Design:
  // docs/architecture/self-hosted-runtime-and-runners.md.
  private static wsOwner(workspace: string): string {
    return `ws:${workspace}`;
  }
  async pairWorkspace(input: Omit<PairRunnerInput, "owner">): Promise<PairedRunner> {
    return this.store.pair({ ...input, owner: RunnerService.wsOwner(input.workspace) });
  }
  async listWorkspaceOwned(workspace: string): Promise<RunnerMeta[]> {
    return this.store.list(RunnerService.wsOwner(workspace));
  }
  async revokeWorkspaceRunner(workspace: string, id: string): Promise<void> {
    await this.store.remove(RunnerService.wsOwner(workspace), id);
  }
}
