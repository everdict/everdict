import type { Driver, RuntimeSpec, TrustZone } from "@everdict/contracts";

// ONE answer to "where may this tenant's work run, and with what credentials".
//
// Every lane that puts a container somewhere used to answer it alone: the eval lane through the dispatcher, the
// sandbox lane with its own driver cache, the browser lane by building a topology runtime straight from the
// spec, file execution not at all (it only ever had the control-plane host). Each re-derived the address, the
// namespace and the trust zone, and each had to remember to pull `spec.authSecret` out of the tenant's secret
// store — which two of them did not, so an ACL-enabled cluster refused work for reasons that looked unrelated.
//
// This is the port they now share (the impl is composition/runtime-compute). A lane asks for the shape it can use:
//   • `computeFor` / `defaultCompute` — a `Driver`, for anything that provisions, execs and disposes
//     (world sessions, the playground, running one file).
//   • `resolve` — the spec + its cluster credentials + the tenant's zone, for a lane whose provisioning the
//     Driver contract does not express: a browser session needs a PUBLISHED CDP port, not an exec channel.
// Both come from the same registry read, the same secret resolution and the same zone.

export interface ResolvedRuntime {
  tenant: string;
  spec: RuntimeSpec;
  // The tenant's secret map, already resolved. `apiToken` is the cluster-API credential lifted out of it —
  // NEVER put it in an alloc env (see .claude/rules/backends.md on credential separation).
  secretEnv: Record<string, string>;
  apiToken?: string;
  zone?: TrustZone;
}

export interface RuntimeCompute {
  // The deployment's own compute, where one is configured — what a lane uses when the caller named no runtime.
  defaultCompute?: Driver;
  // A tenant's REGISTERED runtime as live compute. undefined = the workspace has no such runtime (the caller
  // turns that into a 404 naming it; a silent fall back to the deployment's compute would run a tenant's code
  // somewhere they did not choose).
  computeFor(tenant: string, runtime: string): Promise<Driver | undefined>;
  // The same resolution, one step earlier.
  resolve(tenant: string, runtime: string): Promise<ResolvedRuntime | undefined>;
}
