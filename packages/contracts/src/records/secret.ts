// Workspace secret record shapes — moved from @everdict/db secret-store in re-architecture P2c.
// The SecretStore interface + impls (and SecretCipher/EncryptedSecret machinery) stay in @everdict/db.

import { z } from "zod";

// scope: "workspace" (owner='') = shared (admin-managed) · "user" (owner=subject) = that user's personal (self-managed, invisible to others).
export type SecretScope = "user" | "workspace";

// A secret's kind:
//  "plain"         = an opaque string (the default — model/provider keys, cluster credentials, …).
//  "offline_token" = a stored long-lived OAuth refresh token ("offline token") that the control plane exchanges for
//                    a short-lived access token on demand. Anywhere the secret is referenced by name, the injected
//                    value is a *freshly-minted access token* (never the refresh token) — the store auto-refreshes it
//                    when the cached one lapses. See docs/secrets.md.
export const SecretKindSchema = z.enum(["plain", "offline_token"]);
export type SecretKind = z.infer<typeof SecretKindSchema>;

export interface SecretMeta {
  name: string;
  updatedAt: string;
  scope: SecretScope;
  kind: SecretKind;
  // offline_token only — the ISO expiry of the currently-cached access token (auto-refreshed before it lapses).
  // Absent for plain secrets. Not sensitive (a timestamp) — surfaced so the UI can show staleness.
  accessTokenExpiresAt?: string;
}

// The two tiers for dispatch resolution — shared + the submitter's personal. resolveHarnessSecrets picks by the referenced scope.
export interface ScopedSecretEntries {
  workspace: Record<string, string>;
  user: Record<string, string>;
}

// The material to register an offline token: a long-lived OAuth refresh token + the token endpoint it's minted
// against. On registration the control plane performs one refresh-token grant (RFC 6749 §6) to validate the token +
// compute the first access-token expiry; thereafter it re-mints a fresh access token whenever the cached one lapses
// (rotating the stored refresh token if the provider issues a new one). clientSecret is optional — public clients omit it.
export const OfflineTokenGrantSchema = z.object({
  tokenUrl: z.string().url().describe("OAuth token endpoint (the refresh-token grant is POSTed here)"),
  clientId: z.string().min(1).describe("OAuth client id"),
  clientSecret: z.string().min(1).optional().describe("OAuth client secret — omit for public clients"),
  refreshToken: z.string().min(1).describe("the long-lived refresh token (the offline token itself)"),
  scope: z.string().min(1).optional().describe("optional OAuth scope to request on refresh"),
});
export type OfflineTokenGrant = z.infer<typeof OfflineTokenGrantSchema>;

// The outcome of a refresh-token grant against the provider's token endpoint (RFC 6749 §5.1).
export interface MintedAccessToken {
  accessToken: string;
  expiresAt: string; // ISO — computed from the grant's expires_in
  refreshToken?: string; // a rotated refresh token, if the provider issued a new one (replaces the stored one)
}
