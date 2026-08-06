import { BadRequestError, ServiceHarnessSpecSchema, UpstreamError } from "@everdict/contracts";
import { perTenantTrustZones } from "@everdict/domain";
import { NomadTopologyRuntime } from "@everdict/topology";
import type { ProvisionedBrowser } from "../../common/browser-session-provisioner.js";
import type { ResolvedRuntime } from "../../common/runtime-compute.js";

// A synthetic service spec for a bare interactive-session browser (no eval, no warm topology). The Nomad browser
// job only reads `target` (image/engine) and the session id, so an empty-services spec is enough; the trust zone
// carries the namespace + isolation. Parsed (not cast) so it stays a valid ServiceHarnessSpec.
function sessionSpec(): ReturnType<typeof ServiceHarnessSpecSchema.parse> {
  return ServiceHarnessSpecSchema.parse({
    kind: "service",
    id: "everdict-browser-session",
    version: "1",
    services: [],
    frontDoor: { service: "browser", submit: "" },
    traceSource: { kind: "otel", endpoint: "" },
  });
}

// Stand up a standalone interactive-session browser on a tenant's REGISTERED runtime and return its
// control-plane-reachable CDP base (browser-profiles S9). Nomad ships first: the browser alloc publishes CDP on a
// host port the control plane reaches (`browserCdpBase`), and it stands up inside the tenant's trust zone
// (namespace + isolation runtime + cross-tenant network deny). K8s (per-session port-forward) and self-hosted
// (reverse relay) are follow-ups. See docs/architecture/browser-profiles.md.
export function runtimeSessionProvision(): (
  runtime: ResolvedRuntime,
  sessionId: string,
) => Promise<ProvisionedBrowser> {
  return async ({ tenant, spec, apiToken, zone: resolvedZone }, sessionId) => {
    // This lane REFUSES to run unzoned. A live browser publishes CDP on a reachable port, so without a
    // per-tenant namespace + network deny one tenant's session can drive another's browser — the specific gap
    // S9 closed. Where the operator declared no policy we still isolate here rather than inherit "none".
    const zone = resolvedZone ?? perTenantTrustZones().resolve(tenant);
    if (spec.kind !== "nomad")
      throw new BadRequestError(
        "BAD_REQUEST",
        { runtime: spec.id, kind: spec.kind },
        "Only Nomad runtimes can host an interactive browser session today — K8s (port-forward) and self-hosted (reverse relay) are follow-ups.",
      );
    const runtime = new NomadTopologyRuntime({
      addr: spec.addr,
      // Control-plane↔cluster auth from the tenant's own secret store (spec.authSecret). This lane could not
      // carry one at all before, so a browser session on an ACL-enabled Nomad simply 403'd.
      ...(apiToken ? { apiToken } : {}),
      ...(spec.namespace ? { namespace: spec.namespace } : {}),
      ...(spec.browserImage ? { browserImage: spec.browserImage } : {}),
    });
    const handle = await runtime.provisionBrowserEnv(sessionSpec(), sessionId, zone);
    const cdpBase = await runtime.browserCdpBase(sessionId, zone).catch(() => undefined);
    if (!cdpBase) {
      await handle.dispose().catch(() => undefined); // don't leak the alloc if it never became reachable
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { runtime: spec.id },
        "The runtime browser session did not become reachable.",
      );
    }
    return { cdpBase, dispose: () => handle.dispose() };
  };
}
