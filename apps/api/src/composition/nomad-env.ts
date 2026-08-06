import { BadRequestError } from "@everdict/contracts";

// THE deployment's Nomad — one address, one credential, one namespace, read once.
//
// Dispatching an eval case and holding a world session open are two modes of one placement target, so they
// must not be able to name two different clusters. They used to: the eval lane read `NOMAD_ADDR` while the
// sandbox lane read `EVERDICT_SANDBOX_NOMAD_ADDR`, and nothing checked that they agreed — a typo in either
// silently split the deployment in half, with sessions running somewhere the scheduler never looked and
// capacity counted against a cluster that held none of them.
//
// The `EVERDICT_SANDBOX_NOMAD_*` names survive as aliases for deployments that already set them, but a
// disagreement is a BOOT FAILURE naming both values, not a quiet second cluster. (Same shape as the trust-zone
// mode: a configuration we cannot honor stops the process rather than running a half-configured control plane.)
export interface DeploymentNomad {
  addr: string;
  apiToken?: string;
  namespace?: string;
}

// One value from a preferred name and its legacy alias. Both set to the same thing is fine (a deployment
// mid-rename); set to different things is the split this whole module exists to refuse.
function agreed(env: NodeJS.ProcessEnv, primary: string, alias: string): string | undefined {
  const a = env[primary]?.trim();
  const b = env[alias]?.trim();
  if (a && b && a !== b)
    throw new BadRequestError(
      "BAD_REQUEST",
      { [primary]: a, [alias]: b },
      `${primary} and ${alias} name different values — the eval lane and the sandbox lane share one Nomad, so they cannot point at two. Set one.`,
    );
  return a || b || undefined;
}

export function deploymentNomad(env: NodeJS.ProcessEnv = process.env): DeploymentNomad | undefined {
  const addr = agreed(env, "NOMAD_ADDR", "EVERDICT_SANDBOX_NOMAD_ADDR");
  if (!addr) return undefined;
  const apiToken = agreed(env, "NOMAD_TOKEN", "EVERDICT_SANDBOX_NOMAD_TOKEN");
  const namespace = agreed(env, "EVERDICT_NOMAD_NAMESPACE", "EVERDICT_SANDBOX_NOMAD_NAMESPACE");
  return { addr, ...(apiToken ? { apiToken } : {}), ...(namespace ? { namespace } : {}) };
}
