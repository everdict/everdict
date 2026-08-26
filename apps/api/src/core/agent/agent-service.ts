import type { AgentSpec, CapabilityOrigin } from "@everdict/contracts";
import type { SaveAgentResult } from "@everdict/contracts/wire";
import { specsEqual } from "@everdict/domain";
import type { AgentRegistry } from "@everdict/registry";

// The human "save" surface for the workspace agent — the version-free upsert the web uses. The raw registry CRUD
// (POST /agents, immutable version) doesn't cover interactive editing: a brand-new id registers 1.0.0; an edit
// (instructions / mcpServers / model change) auto patch-bumps to a NEW immutable version so `latest` picks up the
// change while any conversation pinned to an older version stays reproducible (mirrors ModelService.saveConnection).
// Idempotent: an unchanged spec is a no-op (no version spam). Unlike models there is no testConnection — an agent
// config has no single reachable endpoint (its MCP servers are probed independently).

// The upsert body: everything but the coordinates the caller doesn't set (id comes from the path, version is assigned).
export type AgentUpsert = Omit<AgentSpec, "id" | "version">;

export interface AgentServiceDeps {
  agents: AgentRegistry;
}

// Auto version (same rule as model save / harness re-pin): semver → patch bump (skip taken), else a "-r<n>" suffix.
function nextVersion(base: string, taken: ReadonlySet<string>): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(base);
  if (m) {
    let patch = Number(m[3]) + 1;
    while (taken.has(`${m[1]}.${m[2]}.${patch}`)) patch += 1;
    return `${m[1]}.${m[2]}.${patch}`;
  }
  let n = 2;
  while (taken.has(`${base}-r${n}`)) n += 1;
  return `${base}-r${n}`;
}

export class AgentService {
  constructor(private readonly deps: AgentServiceDeps) {}

  // Version-free upsert. New id → 1.0.0; a changed spec on an existing id → next patch version (new immutable version,
  // `latest` moves); an unchanged spec → idempotent no-op (created:false, no version written).
  // The birth stamp is REQUIRED at this seam (evolution-lineage Track A): the optional shape is how the
  // harness re-pin dropped its ancestry for as long as it did. The caller assembles the channel half (and
  // may declare `from` — the campaign's issue — for a FIRST version); on a BUMP the service overrides
  // `from` with the base it just resolved, because it is the only code that knows the ancestor at the write
  // and a caller-declared one would be a second spelling of that fact (L3). The harvester then reads a
  // same-family `from` as the `succeeds` lineage edge.
  async saveAgent(
    tenant: string,
    subject: string | undefined,
    id: string,
    body: AgentUpsert,
    origin: CapabilityOrigin,
  ): Promise<SaveAgentResult> {
    const own = await this.deps.agents.ownVersions(tenant, id); // tenant-owned live versions, ascending; no _shared fallback
    if (own.length > 0) {
      const latest = await this.deps.agents.get(tenant, id, "latest"); // tenant owns it → resolves to its own latest
      // Compare content at the same version so the version field itself doesn't force a difference (order-independent).
      if (specsEqual({ ...body, id, version: latest.version }, latest))
        return { workspace: tenant, id, version: latest.version, created: false };
      const version = nextVersion(latest.version, new Set(own));
      const stamped: CapabilityOrigin = { ...origin, from: { type: "agent", id, version: latest.version } };
      await this.deps.agents.register(tenant, { ...body, id, version }, subject, undefined, stamped);
      return { workspace: tenant, id, version, created: true };
    }
    const version = "1.0.0";
    await this.deps.agents.register(tenant, { ...body, id, version }, subject, undefined, origin);
    return { workspace: tenant, id, version, created: true };
  }
}
