import {
  BadRequestError,
  type EnvValue,
  type ExecArtifact,
  HARNESS_AUTH_ENV_VARS,
  type HarnessSpec,
  isPulledCommandTrace,
  normalizeExecArtifact,
} from "@everdict/contracts";

// Harness secret-resolution semantics — the {secretRef} env vocabulary is defined by the HarnessSpec
// shape (@everdict/contracts); the resolution/visibility rules live here (single owner).

// Flatten an env map to a string map — substitute {secretRef} with its value from lookup.
//
// AN UNRESOLVED REFERENCE IS A REFUSAL, NOT AN OMISSION (downstream report 5.1). This used to drop what it
// could not resolve, so the key came out ABSENT — indistinguishable from "never declared". A topology then
// deployed green with exactly the variables that matter missing, the agent failed at its first authenticated
// call, and the operator read a provider 401 that pointed nowhere near dispatch. Two harness registrations
// differing only in inlined-vs-referenced secrets behaved completely differently and nothing said why.
//
// No caller wants a half-populated env: either the control plane already resolved these before dispatch
// (the normal path, and then `lookup` is irrelevant because the values are literals), or something upstream
// went wrong and the deploy must not proceed pretending otherwise.
export function flattenEnv(env: Record<string, EnvValue>, lookup: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  const unresolved: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") {
      out[k] = v;
      continue;
    }
    const val = lookup[v.secretRef];
    if (val !== undefined) out[k] = val;
    else unresolved.push(`${k}={secretRef:${v.secretRef}}`);
  }
  if (unresolved.length > 0)
    throw new BadRequestError(
      "BAD_REQUEST",
      { unresolved },
      `Unresolved secret reference(s): ${unresolved.join(", ")} — the control plane resolves these before dispatch, so reaching here means the resolved spec was not the one used.`,
    );
  return out;
}

// Secret tier maps — workspace (shared) + user (submitter's personal). Picked by the reference's scope.
export interface HarnessSecretMaps {
  workspace: Record<string, string>;
  user?: Record<string, string>;
}

// One env map's {secretRef} values resolved against the tiers. The rule lives HERE so every carrier of an env
// map — a harness spec's services, a delegation profile's env — resolves references identically; `missing`
// collects the unresolvable names so the caller can refuse with all of them named at once (never silently
// dropping a variable the author declared). Callers without their own collector pass a fresh set and check it.
export function resolveEnvValues(
  env: Record<string, EnvValue>,
  secrets: HarnessSecretMaps,
  missing: Set<string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") {
      out[k] = v;
      continue;
    }
    const isUser = v.scope === "user";
    const val = (isUser ? (secrets.user ?? {}) : secrets.workspace)[v.secretRef];
    if (val === undefined) {
      missing.add(`${isUser ? "user:" : ""}${v.secretRef}`);
      continue;
    }
    out[k] = val;
  }
  return out;
}

// Resolve secret references to their actual values across all env maps of a harness spec (just before dispatch, from SecretStore).
// command = env, service = each service's env. The reference's scope ("user" | default "workspace") picks the tier.
// If a referenced secret is missing, throw BadRequestError (stating what/which tier is missing).
// All env values in the returned spec become strings (no plaintext stored in the registry) so consumption points use them directly.
export function resolveHarnessSecrets(spec: HarnessSpec, secrets: HarnessSecretMaps): HarnessSpec {
  const missing = new Set<string>();
  const resolve = (env: Record<string, EnvValue>): Record<string, string> => resolveEnvValues(env, secrets, missing);
  const resolveArtifact = (artifact: ExecArtifact): ExecArtifact => {
    const normalized = normalizeExecArtifact(artifact);
    if (!normalized?.headers) return artifact;
    return { ...normalized, headers: resolve(normalized.headers) };
  };

  // command's trace.authSecret (workspace secret name) → transient trace.auth value — in-job (collect=job) pull uses it
  // as the auth header (the agent can't reach SecretStore, so it's resolved just before dispatch like env).
  const resolveTrace = (trace: Extract<HarnessSpec, { kind: "command" }>["trace"]) => {
    if (!isPulledCommandTrace(trace) || !trace.authSecret) return trace;
    const val = secrets.workspace[trace.authSecret];
    if (val === undefined) {
      missing.add(trace.authSecret);
      return trace;
    }
    return { ...trace, auth: val };
  };

  const next: HarnessSpec =
    spec.kind === "command"
      ? { ...spec, env: resolve(spec.env), trace: resolveTrace(spec.trace) }
      : spec.kind === "service"
        ? {
            ...spec,
            services: spec.services.map((s) => ({
              ...s,
              env: resolve(s.env),
              // A host-exec service's artifact headers are the same kind of value under a different key: a
              // private artifact repository needs auth, and a token written literally into a spec would sit in
              // the registry in plaintext. Resolved here, with the same collector, so an unresolvable one is
              // refused by name beside every other missing secret rather than dropped at render time.
              ...(s.exec?.artifact !== undefined
                ? { exec: { ...s.exec, artifact: resolveArtifact(s.exec.artifact) } }
                : {}),
            })),
          }
        : spec;

  if (missing.size > 0) {
    throw new BadRequestError(
      "BAD_REQUEST",
      { secrets: [...missing] },
      `Referenced secrets are missing: ${[...missing].join(", ")}. Register them first in settings (user: = personal secret).`,
    );
  }
  return next;
}

// Pick the harness model-auth env vars (the HARNESS_AUTH_ENV_VARS vocabulary) from the tenant's secret
// tiers — workspace value first, the submitter's personal secret as fallback. This is the backend
// secret-injection discipline applied to the driver lane: a fresh session container has no machine login,
// so `claude` (or any CLI agent) auths from these values via RunContext.apiKeyEnv. Values stay in process
// memory — never on a record, a trace, or a spec.
export function harnessAuthEnv(secrets: HarnessSecretMaps): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of HARNESS_AUTH_ENV_VARS) {
    const val = secrets.workspace[name] ?? secrets.user?.[name];
    if (val !== undefined) out[name] = val;
  }
  return out;
}

// Does any env reference a user-scoped secret — if so, this harness can only be run/viewed by that user (private).
// The list/detail visibility filter uses this together with createdBy to hide it from other users.
export function referencesUserSecret(spec: HarnessSpec): boolean {
  const has = (env: Record<string, EnvValue>): boolean =>
    Object.values(env).some((v) => typeof v !== "string" && v.scope === "user");
  if (spec.kind === "command") return has(spec.env);
  if (spec.kind === "service") return spec.services.some((s) => has(s.env));
  return false;
}
