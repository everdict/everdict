// OAuth pending-state record shape — moved from @everdict/db oauth-state-store in re-architecture P2c.
// The OAuthStateStore interface + impls + generateOAuthState stay in @everdict/db.

// Single-use pending state between OAuth authorize→callback (CSRF + callback-context restore). self-hosted (GHE/Mattermost)
// carries host + clientId (public) + clientSecretName (a SecretStore key name — not the value) to re-resolve the credentials in the callback.
export interface OAuthStatePending {
  workspace: string;
  provider: string;
  host?: string;
  clientId?: string; // self-hosted OAuth app client_id (public)
  clientSecretName?: string; // SecretStore key name of the self-hosted client_secret (not the value)
  createdBy: string;
}
