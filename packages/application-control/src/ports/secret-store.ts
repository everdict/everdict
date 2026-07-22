import type { OfflineTokenGrant, ScopedSecretEntries, SecretMeta } from "@everdict/contracts";

// Workspace secret store — manages model/provider keys (OPENAI_API_KEY etc.) per scope.
// scope: "workspace" (owner='') = shared (admin-managed) · "user" (owner=subject) = that user's personal (self-managed, invisible to others).
// Values are AES-GCM encrypted at rest and never returned as plaintext (list has only name+scope). Only entries/scopedEntries decrypt (injection-only).
//
// Two kinds (SecretMeta.kind): "plain" opaque strings (set) and "offline_token" — a stored long-lived OAuth refresh
// token the store exchanges for a fresh access token on read (setOfflineToken). entries/scopedEntries yield the same
// Record<name, value> shape for both kinds; an offline_token resolves to a currently-valid *access token*, so every
// existing consumer (harness env {secretRef}, model apiKeySecret, trace/runtime auth) transparently gets a live token.
export interface SecretStore {
  // owner="" = workspace (shared) secret, owner=subject = user personal secret.
  set(workspace: string, name: string, value: string, owner?: string): Promise<void>;
  // Register/replace an offline_token secret. Performs one refresh-token grant to validate the token + compute the
  // first access-token expiry, then stores the (encrypted) material and returns the resulting meta (with expiry).
  // Throws UpstreamError if the provider rejects the grant. Requires an OfflineTokenMinter wired into the store.
  setOfflineToken(workspace: string, name: string, grant: OfflineTokenGrant, owner?: string): Promise<SecretMeta>;
  // With subject, also returns that user's personal secrets (scope-tagged). Unset returns shared secrets only.
  list(workspace: string, subject?: string): Promise<SecretMeta[]>;
  remove(workspace: string, name: string, owner?: string): Promise<void>;
  entries(workspace: string): Promise<Record<string, string>>; // shared (owner='') secrets only — existing-consumer compat
  scopedEntries(workspace: string, subject: string): Promise<ScopedSecretEntries>; // shared + that user's personal
}
