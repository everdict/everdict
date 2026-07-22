import type { OfflineTokenMinter } from "@everdict/application-control";
import { type MintedAccessToken, type OfflineTokenGrant, UpstreamError } from "@everdict/contracts";
import { z } from "zod";
import { oauthFetchJson } from "./provider.js";

// The subset of an OAuth2 token-endpoint response we consume (RFC 6749 §5.1). expires_in is in seconds; refresh_token
// is present only when the provider rotates it. token_type/scope are ignored (we always inject the access token verbatim).
const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive().optional(),
  refresh_token: z.string().min(1).optional(),
});

// If the provider omits expires_in, cache the access token only briefly (re-mint each dispatch window) rather than
// assume a long life — a conservative default keeps a missing expiry from letting a token be reused past its real end.
const DEFAULT_TTL_SECONDS = 300;

// HTTP OfflineTokenMinter — the OAuth2 refresh-token grant (RFC 6749 §6). POSTs the stored refresh token to the grant's
// token endpoint (form-encoded), returns the fresh access token + its absolute expiry (computed from expires_in) + any
// rotated refresh token. All failures remap to UpstreamError via oauthFetchJson (never a raw fetch/HTTP error).
export function httpOfflineTokenMinter(now: () => number = () => Date.now()): OfflineTokenMinter {
  return {
    async mint(grant: OfflineTokenGrant): Promise<MintedAccessToken> {
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: grant.refreshToken,
        client_id: grant.clientId,
      });
      if (grant.clientSecret) body.set("client_secret", grant.clientSecret);
      if (grant.scope) body.set("scope", grant.scope);
      const json = await oauthFetchJson(grant.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: body.toString(),
      });
      const parsed = TokenResponseSchema.safeParse(json);
      if (!parsed.success)
        throw new UpstreamError(
          "UPSTREAM_ERROR",
          { tokenUrl: grant.tokenUrl },
          "the token endpoint response had no access_token",
        );
      const ttl = parsed.data.expires_in ?? DEFAULT_TTL_SECONDS;
      return {
        accessToken: parsed.data.access_token,
        expiresAt: new Date(now() + ttl * 1000).toISOString(),
        ...(parsed.data.refresh_token ? { refreshToken: parsed.data.refresh_token } : {}),
      };
    },
  };
}
