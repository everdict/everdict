import type { MintedAccessToken, OfflineTokenGrant } from "@everdict/contracts";

// Outbound OAuth refresh-token grant (RFC 6749 §6) — exchange a stored long-lived refresh token ("offline token")
// for a fresh short-lived access token at the provider's token endpoint. Injected into the SecretStore (like
// SecretCipher) so the store can keep an offline_token secret's cached access token fresh; the HTTP impl lives in
// apps/api (infrastructure/oauth), keeping OAuth I/O out of @everdict/db. Failures remap to AppError (UpstreamError).
export interface OfflineTokenMinter {
  mint(grant: OfflineTokenGrant): Promise<MintedAccessToken>;
}
