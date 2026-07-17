import { BadRequestError, NotFoundError, type RuntimeSpec, type TrustZone } from "@everdict/contracts";
import type {
  BrowserSessionProvisioner,
  ProvisionBrowserOptions,
  ProvisionedBrowser,
} from "../../common/browser-session-provisioner.js";

export interface RuntimeBrowserProvisionerDeps {
  // Resolve the tenant's registered runtime by id (RuntimeRegistry.get). undefined ⇒ the session 404s (no such runtime).
  resolveSpec: (tenant: string, runtimeId: string) => Promise<RuntimeSpec | undefined>;
  // Tenant → trust zone (TrustZonePolicy.resolve) — the browser stands up in this zone (namespace + isolation
  // runtime + cross-tenant network deny), so one tenant's live session can't reach another's CDP over the network.
  zoneFor: (tenant: string) => TrustZone;
  // Stand up a browser on the given runtime keyed by session id, returning its control-plane-reachable CDP + disposer.
  // Injected by the composition (it builds the orchestrator-specific TopologyRuntime); this keeps apps/api's topology
  // wiring out of the provisioner so the resolution/isolation logic here is unit-testable with a fake.
  provisionOnRuntime: (spec: RuntimeSpec, sessionId: string, zone: TrustZone) => Promise<ProvisionedBrowser>;
}

// Hosts an interactive browser session on the tenant's REGISTERED runtime (browser-profiles S9) instead of the
// control-plane host. This is what lets sessions work when apps/api is itself containerized (full compose / managed
// K8s) — the browser runs on the tenant's cluster and the control plane reaches its CDP over the network — and it
// closes the cross-tenant CDP-theft gap: each tenant's session runs in its own trust zone. See
// docs/architecture/browser-profiles.md.
export class RuntimeBrowserProvisioner implements BrowserSessionProvisioner {
  constructor(private readonly deps: RuntimeBrowserProvisionerDeps) {}

  async provision(opts?: ProvisionBrowserOptions): Promise<ProvisionedBrowser> {
    // The router only sends us here when `runtime` is set; tenant/sessionId are always supplied by the service.
    if (!opts?.runtime || !opts.tenant || !opts.sessionId)
      throw new BadRequestError(
        "BAD_REQUEST",
        { need: ["tenant", "runtime", "sessionId"] },
        "A runtime-hosted browser session requires a tenant, a runtime, and a session id.",
      );
    const spec = await this.deps.resolveSpec(opts.tenant, opts.runtime);
    if (!spec)
      throw new NotFoundError(
        "NOT_FOUND",
        { runtime: opts.runtime },
        "Runtime not found — register it (or pick another) before hosting a browser session on it.",
      );
    const zone = this.deps.zoneFor(opts.tenant);
    return this.deps.provisionOnRuntime(spec, opts.sessionId, zone);
  }
}
