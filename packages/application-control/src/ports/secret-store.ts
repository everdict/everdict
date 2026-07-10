import type { ScopedSecretEntries, SecretMeta } from "@everdict/contracts";

// Workspace secret store — manages model/provider keys (OPENAI_API_KEY etc.) per scope.
// scope: "workspace" (owner='') = shared (admin-managed) · "user" (owner=subject) = that user's personal (self-managed, invisible to others).
// Values are AES-GCM encrypted at rest and never returned as plaintext (list has only name+scope). Only entries/scopedEntries decrypt (injection-only).
export interface SecretStore {
  // owner="" = workspace (shared) secret, owner=subject = user personal secret.
  set(workspace: string, name: string, value: string, owner?: string): Promise<void>;
  // With subject, also returns that user's personal secrets (scope-tagged). Unset returns shared secrets only.
  list(workspace: string, subject?: string): Promise<SecretMeta[]>;
  remove(workspace: string, name: string, owner?: string): Promise<void>;
  entries(workspace: string): Promise<Record<string, string>>; // shared (owner='') secrets only — existing-consumer compat
  scopedEntries(workspace: string, subject: string): Promise<ScopedSecretEntries>; // shared + that user's personal
}
