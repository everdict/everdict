import {
  CapabilityNameSchema,
  type PairRunnerInput,
  type PairedRunner,
  RUNNER_PROTOCOL_VERSION,
  type RunnerMeta,
} from "@everdict/contracts";
import { z } from "zod";
import type { RunnerStore } from "../ports/runner-store.js";

// A runner is out of date when the protocol it built with is BELOW this control plane's — it is running older code than
// the server, so the runner-facing job/lease contract may have moved on. A runner that reports no protocol (pre-version)
// is left unflagged: we cannot know it is behind, and nagging every legacy runner on day one would be noise (its own
// auto-update brings it to a protocol-reporting build anyway). Pure — shared by lease (signal) and list (roster badge).
export function runnerUpdateRequired(protocol: number | undefined): boolean {
  return protocol !== undefined && protocol < RUNNER_PROTOCOL_VERSION;
}

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

// Overlay the derived (never stored) update-required flag onto a stored runner meta for read paths (roster/list).
function withUpdateRequired(meta: RunnerMeta): RunnerMeta {
  return runnerUpdateRequired(meta.protocol) ? { ...meta, updateRequired: true } : meta;
}

export class RunnerService {
  constructor(private readonly store: RunnerStore) {}
  // Personally-owned: owner=principal.subject. The plaintext token rides out in the result exactly once (stored as a hash).
  async pair(input: PairRunnerInput): Promise<PairedRunner> {
    return this.store.pair(input);
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
  // Runner self-report of its OS (process.platform) at lease time → the roster fills in the OS badge with no user input.
  // Bounded at this boundary (same 40-char ceiling as the pair body) to never persist an oversized self-report. No-op if the runner doesn't exist.
  async setOs(owner: string, id: string, os: string): Promise<void> {
    const trimmed = os.trim();
    if (trimmed.length === 0) return; // ignore an empty self-report rather than blank out the stored OS
    await this.store.setOs(owner, id, trimmed.slice(0, 40));
  }
  // Runner self-report of its build/protocol version (on lease). The control plane derives `updateRequired` from the
  // stored protocol (roster badge) — see runnerUpdateRequired. Bounded/validated at this boundary. No-op if the runner doesn't exist.
  async reportVersion(owner: string, id: string, version: string, protocol: number): Promise<void> {
    if (!Number.isInteger(protocol)) return; // ignore a malformed self-report rather than persist garbage
    await this.store.setVersion(owner, id, version.slice(0, 80), protocol);
  }
  // Personal list — my runners (owner-scoped), annotated with the derived update-required flag (never stored).
  async list(owner: string): Promise<RunnerMeta[]> {
    return (await this.store.list(owner)).map(withUpdateRequired);
  }
  // Workspace roster (read-only) — metadata for runners paired in this workspace (no tokens). For the settings > members tab.
  async listForWorkspace(workspace: string): Promise<RunnerMeta[]> {
    return (await this.store.listByWorkspace(workspace)).map(withUpdateRequired);
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
    return (await this.store.list(RunnerService.wsOwner(workspace))).map(withUpdateRequired);
  }
  async revokeWorkspaceRunner(workspace: string, id: string): Promise<void> {
    await this.store.remove(RunnerService.wsOwner(workspace), id);
  }
}
