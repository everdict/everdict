// Workspace secret record shapes — moved from @everdict/db secret-store in re-architecture P2c.
// The SecretStore interface + impls (and SecretCipher/EncryptedSecret machinery) stay in @everdict/db.

// scope: "workspace" (owner='') = shared (admin-managed) · "user" (owner=subject) = that user's personal (self-managed, invisible to others).
export type SecretScope = "user" | "workspace";

export interface SecretMeta {
  name: string;
  updatedAt: string;
  scope: SecretScope;
}

// The two tiers for dispatch resolution — shared + the submitter's personal. resolveHarnessSecrets picks by the referenced scope.
export interface ScopedSecretEntries {
  workspace: Record<string, string>;
  user: Record<string, string>;
}
