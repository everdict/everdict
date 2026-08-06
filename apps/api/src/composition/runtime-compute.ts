import {
  type Backend,
  type BackendRegistry,
  DockerBackend,
  NomadBackend,
  buildRuntimeBackend,
  isSessionable,
} from "@everdict/backends";
import { BadRequestError, type Driver } from "@everdict/contracts";
import type { TrustZonePolicy } from "@everdict/domain";
import type { RuntimeRegistry } from "@everdict/registry";
import type { ResolvedRuntime, RuntimeCompute } from "../common/runtime-compute.js";

export type { ResolvedRuntime, RuntimeCompute } from "../common/runtime-compute.js";
import type { DeploymentCompute } from "./compute-env.js";
import type { DeploymentNomad } from "./nomad-env.js";

// The live wiring behind `RuntimeCompute` (../common/runtime-compute) — one registry read, one secret
// resolution, one zone, for every lane that needs somewhere to run.

export function buildRuntimeCompute(opts: {
  runtimes?: RuntimeRegistry;
  // tenant → its decrypted secret map (cluster credentials live here, never in the spec).
  secretsFor?: (tenant: string) => Promise<Record<string, string>>;
  trustZones?: TrustZonePolicy;
  // The deployment's own placement targets — a `nomad` registered here IS this deployment's cluster, so a lane
  // that holds compute open takes THAT object rather than a lookalike beside it.
  backends?: BackendRegistry;
  // What this deployment can hold open, and where (composition/compute-env + composition/nomad-env).
  compute?: DeploymentCompute;
  nomad?: DeploymentNomad;
  jobImage?: string;
}): RuntimeCompute {
  const cache = new Map<string, Driver>();

  const resolve = async (tenant: string, runtime: string): Promise<ResolvedRuntime | undefined> => {
    if (!opts.runtimes) return undefined;
    const spec = await opts.runtimes.get(tenant, runtime).catch(() => undefined);
    if (!spec) return undefined;
    const secretEnv = opts.secretsFor ? await opts.secretsFor(tenant) : {};
    // The cluster-API credential, by the name the spec gave it. `local` has none — it is this host.
    const authSecret = spec.kind === "local" ? undefined : spec.authSecret;
    const apiToken = authSecret ? secretEnv[authSecret] : undefined;
    const zone = opts.trustZones?.resolve(tenant);
    return { tenant, spec, secretEnv, ...(apiToken ? { apiToken } : {}), ...(zone ? { zone } : {}) };
  };

  const computeFor = async (tenant: string, runtime: string): Promise<Driver | undefined> => {
    const resolved = await resolve(tenant, runtime);
    if (!resolved) return undefined;
    const key = `${tenant}:${resolved.spec.id}@${resolved.spec.version}`;
    const cached = cache.get(key);
    if (cached) return cached;
    // Built by the SAME builder a dispatched case goes through, so the cluster credential separation, the
    // isolation policy and the capacity envelope are inherited rather than re-implemented per lane.
    const backend = buildRuntimeBackend(resolved.spec, {
      secretEnv: resolved.secretEnv,
      ...(opts.trustZones ? { trustZones: opts.trustZones } : {}),
    });
    const built = asHoldableCompute(backend, resolved.spec.kind, runtime);
    cache.set(key, built);
    return built;
  };

  const defaultBackend = deploymentTarget(opts);

  // The deployment's own target, narrowed once at composition time: an operator who configured compute this
  // process cannot hold open learns at BOOT, not on the first member's click.
  const defaultCompute = defaultBackend ? asHoldableCompute(defaultBackend, opts.compute?.kind ?? "") : undefined;
  return { ...(defaultCompute ? { defaultCompute } : {}), computeFor, resolve };
}

// A placement target, narrowed to the mode that HOLDS compute open (`isSessionable` — the compiler-checked
// guard the backends layer uses for every other capability). A target that only runs a job to completion is
// refused by name, up front, instead of failing somewhere inside the first exec.
export function asHoldableCompute(backend: Backend, kind: string, runtime?: string): Driver {
  if (!isSessionable(backend))
    throw new BadRequestError(
      "BAD_REQUEST",
      { ...(runtime !== undefined ? { runtime } : {}), kind },
      `A ${kind} target runs a job to completion and cannot hold compute open — register a nomad runtime for sessions and file runs.`,
    );
  return backend;
}

// The deployment's own target, from the one compute block. `nomad` prefers the object the eval lane already
// registered: a case and a held-open session on the same cluster must not be owned twice (that is how a live
// session ends up invisible to `capacity()`). `docker` is this host — the dev path, and the only one that can
// snapshot through a daemon.
function deploymentTarget(opts: {
  backends?: BackendRegistry;
  compute?: DeploymentCompute;
  nomad?: DeploymentNomad;
  jobImage?: string;
  trustZones?: TrustZonePolicy;
}): Backend | undefined {
  if (!opts.compute) return undefined;
  if (opts.compute.kind === "docker") return new DockerBackend();
  const registered = opts.backends?.tryGet("nomad");
  if (registered) return registered;
  if (!opts.nomad) return undefined;
  return new NomadBackend({
    addr: opts.nomad.addr,
    // The DISPATCH-mode image (what an eval case runs). A lane that holds compute open boots the image its
    // ComputeSpec names, so this only matters if the same target is also asked to place a case.
    image: opts.jobImage ?? "everdict-job-runner",
    ...(opts.nomad.apiToken ? { apiToken: opts.nomad.apiToken } : {}),
    ...(opts.nomad.namespace ? { namespace: opts.nomad.namespace } : {}),
    // The SAME isolation policy the dispatch lanes use — code held open is untrusted exactly as an eval case
    // is, and must not be isolated by a second, nearby rule.
    ...(opts.trustZones ? { trustZones: opts.trustZones } : {}),
  });
}
