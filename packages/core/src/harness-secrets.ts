import { BadRequestError } from "./errors.js";
import type { EnvValue, HarnessSpec } from "./harness-spec.js";

// Flatten an env map to a string map — substitute {secretRef} with its value from lookup.
// For narrowing the type at consumption points (CommandHarness / topology runtime): silently drop unresolved references
// (either the control plane already resolved them via resolveHarnessSecrets, or the secret is missing → that env is unset).
export function flattenEnv(env: Record<string, EnvValue>, lookup: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") {
      out[k] = v;
      continue;
    }
    const val = lookup[v.secretRef];
    if (val !== undefined) out[k] = val;
  }
  return out;
}

// Secret tier maps — workspace (shared) + user (submitter's personal). Picked by the reference's scope.
export interface HarnessSecretMaps {
  workspace: Record<string, string>;
  user?: Record<string, string>;
}

// Resolve secret references to their actual values across all env maps of a harness spec (just before dispatch, from SecretStore).
// command = env, service = each service's env. The reference's scope ("user" | default "workspace") picks the tier.
// If a referenced secret is missing, throw BadRequestError (stating what/which tier is missing).
// All env values in the returned spec become strings (no plaintext stored in the registry) so consumption points use them directly.
export function resolveHarnessSecrets(spec: HarnessSpec, secrets: HarnessSecretMaps): HarnessSpec {
  const missing = new Set<string>();
  const resolve = (env: Record<string, EnvValue>): Record<string, string> => {
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
  };

  // command's trace.authSecret (workspace secret name) → transient trace.auth value — in-job (collect=job) pull uses it
  // as the auth header (the agent can't reach SecretStore, so it's resolved just before dispatch like env).
  const resolveTrace = (trace: Extract<HarnessSpec, { kind: "command" }>["trace"]) => {
    if (trace.kind === "none" || !trace.authSecret) return trace;
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
        ? { ...spec, services: spec.services.map((s) => ({ ...s, env: resolve(s.env) })) }
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

// Does any env reference a user-scoped secret — if so, this harness can only be run/viewed by that user (private).
// The list/detail visibility filter uses this together with createdBy to hide it from other users.
export function referencesUserSecret(spec: HarnessSpec): boolean {
  const has = (env: Record<string, EnvValue>): boolean =>
    Object.values(env).some((v) => typeof v !== "string" && v.scope === "user");
  if (spec.kind === "command") return has(spec.env);
  if (spec.kind === "service") return spec.services.some((s) => has(s.env));
  return false;
}
