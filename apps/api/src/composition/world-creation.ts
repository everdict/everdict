import type { WorldCreator } from "@everdict/application-control";
import { BadRequestError, nomadTopologyTransport } from "@everdict/contracts";
import { NomadTopologyRuntime, topologyWorldCreator } from "@everdict/topology";
import type { ResolvedRuntime } from "../common/runtime-compute.js";

// ── THE PRODUCTION CREATOR OF WORLDS (docs/architecture/world-and-engagement-model.md, 3.9) ──────────
//
// A created world stands on the TENANT'S OWN runtime, resolved exactly the way an interactive browser
// session and a file run resolve theirs — one answer to "which cluster, which credential, which zone"
// instead of one per lane. The protocol around it (record before creating, settle only on a read-back) lives
// in `@everdict/application-control`; this is the part that knows how to reach a cluster.
//
// NOMAD FIRST, and refused by name elsewhere. The browser-session lane made the same call for the same
// reason: K8s needs a port-forward story and the self-hosted lane a reverse relay, and a world that came up
// on a runtime this control plane cannot then tear down is precisely the leak the ledger exists to prevent.
// A refusal here is a case that does not run; a silent fallback would be a world nobody reclaims.
export function buildWorldCreator(deps: {
  resolve: (tenant: string, runtimeId: string) => Promise<ResolvedRuntime | undefined>;
}): WorldCreator {
  const creatorFor = async (tenant: string, target: string | undefined): Promise<WorldCreator> => {
    if (target === undefined)
      throw new BadRequestError(
        "BAD_REQUEST",
        { tenant },
        "this case creates its world and names no runtime to create it on — a world with no cluster has nowhere to stand and nothing to tear it down",
      );
    const resolved = await deps.resolve(tenant, target);
    if (resolved === undefined)
      throw new BadRequestError(
        "BAD_REQUEST",
        { tenant, runtime: target },
        `no such runtime '${target}' in this workspace — the world was not created`,
      );
    if (resolved.spec.kind !== "nomad")
      throw new BadRequestError(
        "BAD_REQUEST",
        { runtime: target, kind: resolved.spec.kind },
        `only Nomad runtimes can host a created world today (this one is '${resolved.spec.kind}') — K8s and self-hosted are follow-ups, and a world this control plane could not tear down is worse than a case that does not run`,
      );
    const runtime = new NomadTopologyRuntime({
      addr: resolved.spec.addr,
      ...(resolved.apiToken ? { apiToken: resolved.apiToken } : {}),
      ...nomadTopologyTransport(resolved.spec),
    });
    return topologyWorldCreator(runtime);
  };
  return {
    create: async (input) => (await creatorFor(input.tenant, input.target)).create(input),
    destroy: async (input) => (await creatorFor(input.tenant, input.target)).destroy(input),
    standing: async (input) => {
      // The read-back may not throw its way into a settlement: a runtime this process cannot even resolve is
      // "we could not find out", which keeps the row owed rather than releasing it on an error's say-so.
      try {
        return await (await creatorFor(input.tenant, input.target)).standing(input);
      } catch {
        return undefined;
      }
    },
  };
}
