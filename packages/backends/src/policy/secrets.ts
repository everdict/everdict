// Per-tenant secret scoping — inject each tenant's model keys (ANTHROPIC_API_KEY etc.) only into that tenant's jobs.
// The key point is that one tenant's key never leaks into another tenant's sandbox (part of multi-tenant isolation).
// async: a DB-backed (workspace secret store) provider can plug in under the same contract.
export interface SecretProvider {
  // Secrets to inject into this tenant's job env. Never mixes in another tenant's.
  secretsFor(tenant: string): Promise<Record<string, string>>;
}

// A fixed mapping: tenant → env. An unregistered tenant gets fallback (or, if absent, empty → runs without keys).
export function staticSecrets(
  byTenant: Record<string, Record<string, string>>,
  fallback: Record<string, string> = {},
): SecretProvider {
  return {
    async secretsFor(tenant) {
      return { ...(byTenant[tenant] ?? fallback) };
    },
  };
}
