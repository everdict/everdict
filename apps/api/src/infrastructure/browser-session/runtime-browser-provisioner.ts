import { BadRequestError, NotFoundError } from "@everdict/contracts";
import type {
  BrowserSessionProvisioner,
  ProvisionBrowserOptions,
  ProvisionedBrowser,
} from "../../common/browser-session-provisioner.js";
import type { ResolvedRuntime } from "../../common/runtime-compute.js";

export interface RuntimeBrowserProvisionerDeps {
  // The tenant's registered runtime, resolved to its spec + cluster credentials + trust zone — the SAME
  // resolver world sessions and file runs go through, so "which cluster, which credential, which zone" has one
  // answer for every lane. undefined ⇒ the session 404s (no such runtime).
  resolve: (tenant: string, runtimeId: string) => Promise<ResolvedRuntime | undefined>;
  // Stand up a browser on that runtime keyed by session id, returning its control-plane-reachable CDP + disposer.
  // Injected by the composition (it builds the orchestrator-specific TopologyRuntime); this keeps apps/api's topology
  // wiring out of the provisioner so the resolution logic here is unit-testable with a fake.
  provisionOnRuntime: (runtime: ResolvedRuntime, sessionId: string) => Promise<ProvisionedBrowser>;
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
    const runtime = await this.deps.resolve(opts.tenant, opts.runtime);
    if (!runtime)
      throw new NotFoundError(
        "NOT_FOUND",
        { runtime: opts.runtime },
        "Runtime not found — register it (or pick another) before hosting a browser session on it.",
      );
    return this.deps.provisionOnRuntime(runtime, opts.sessionId);
  }
}
