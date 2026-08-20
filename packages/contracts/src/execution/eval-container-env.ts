import { HARNESS_AUTH_ENV_VARS } from "../harness/auth-env.js";

// ── WHAT AN EVAL CONTAINER MAY BE HANDED FROM THE WORKSPACE'S SECRETS ────────────────────────────────
//
// The managed lanes injected the tenant's ENTIRE secret tier into the job container — `secretsFor(tenant)`
// is every secret the workspace has ever stored: its GitHub App token, its Mattermost bot token, its
// registry passwords, whatever a member saved for an integration. The process that then runs in that
// container is the AGENT UNDER TEST, arbitrary code with permissions deliberately disabled, and
// `LocalDriver` execs it with `{ ...process.env, ...opts.env }`. Reading the workspace's credentials was
// one `env` away.
//
// It was never a decision, it was a default that outlived its reason. The blanket injection predates the
// per-job channels that now exist:
//
//   · a harness's DECLARED env (`{secretRef}`) is resolved into the job before dispatch
//     (`resolveHarnessSecrets`), so a declared secret never needed the ambient tier;
//   · a judge's provider key rides the job as `judgeAuth`, resolved per dispatch;
//   · the runner itself reads only `HARNESS_AUTH_ENV_VARS` out of its own environment (`collectAuthEnv`).
//
// So the tier is filtered to that last vocabulary: the names the harness under test genuinely needs to call
// a model, and nothing else. A workspace secret the harness needs but never declared stops arriving — which
// is the undeclared dependency ending, and it ends with a name the operator can act on rather than silently.
//
// The two managed backends share this function rather than each filtering their own way: the whole point is
// that a tenant's exposure does not depend on which orchestrator placed the job.
export function evalContainerSecretEnv(
  secretEnv: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (secretEnv === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const name of HARNESS_AUTH_ENV_VARS) {
    const value = secretEnv[name];
    if (value !== undefined) out[name] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
