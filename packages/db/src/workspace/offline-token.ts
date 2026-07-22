import type { OfflineTokenMinter } from "@everdict/application-control";
import { InternalError, type OfflineTokenGrant } from "@everdict/contracts";
import { z } from "zod";

// The plaintext JSON payload of an offline_token secret row (encrypted at rest, exactly like a plain value). Holds
// the OAuth material + the currently-cached access token. The refresh token rotates over time (a provider may issue a
// new one on each grant); accessTokenExpiresAt mirrors the row's clear access_token_expires_at column (which exists so
// `list` can show expiry without decrypting).
export const OfflineTokenEnvelopeSchema = z.object({
  tokenUrl: z.string(),
  clientId: z.string(),
  clientSecret: z.string().optional(),
  refreshToken: z.string(),
  scope: z.string().optional(),
  accessToken: z.string(),
  accessTokenExpiresAt: z.string(),
});
export type OfflineTokenEnvelope = z.infer<typeof OfflineTokenEnvelopeSchema>;

// Re-mint a bit before the cached access token actually expires, so we never hand out an about-to-die token.
const REFRESH_SKEW_MS = 60_000;

export function encodeEnvelope(env: OfflineTokenEnvelope): string {
  return JSON.stringify(env);
}

// Decode our own encrypted payload. A parse failure is internal corruption (we wrote it), not a user-boundary error.
export function decodeEnvelope(plaintext: string): OfflineTokenEnvelope {
  const parsed = OfflineTokenEnvelopeSchema.safeParse(JSON.parse(plaintext));
  if (!parsed.success)
    throw new InternalError(
      "UPSTREAM_MISCONFIGURED",
      { issues: parsed.error.issues },
      "corrupt offline-token secret payload",
    );
  return parsed.data;
}

function grantOf(env: OfflineTokenEnvelope): OfflineTokenGrant {
  return {
    tokenUrl: env.tokenUrl,
    clientId: env.clientId,
    ...(env.clientSecret ? { clientSecret: env.clientSecret } : {}),
    refreshToken: env.refreshToken,
    ...(env.scope ? { scope: env.scope } : {}),
  };
}

// Manages an offline_token secret's cached access token: the initial mint at registration + the refresh-on-read that
// keeps it fresh. The HTTP grant is delegated to the injected OfflineTokenMinter (so OAuth I/O stays out of @everdict/db);
// this class owns only the pure "is it expired?" decision, refresh-token rotation, and in-process dedup of concurrent
// refreshes for the same secret (so one lapsed token = one grant, not one per referencing dispatch).
export class OfflineTokenManager {
  private readonly inflight = new Map<string, Promise<OfflineTokenEnvelope>>();
  constructor(
    private readonly minter: OfflineTokenMinter | undefined,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private require(): OfflineTokenMinter {
    if (!this.minter) throw new InternalError("UPSTREAM_MISCONFIGURED", {}, "offline-token minter is not configured");
    return this.minter;
  }

  // Registration: one refresh-token grant to validate the token + compute the first expiry → the envelope to persist.
  async mintInitial(grant: OfflineTokenGrant): Promise<OfflineTokenEnvelope> {
    const minted = await this.require().mint(grant);
    return {
      tokenUrl: grant.tokenUrl,
      clientId: grant.clientId,
      ...(grant.clientSecret ? { clientSecret: grant.clientSecret } : {}),
      refreshToken: minted.refreshToken ?? grant.refreshToken,
      ...(grant.scope ? { scope: grant.scope } : {}),
      accessToken: minted.accessToken,
      accessTokenExpiresAt: minted.expiresAt,
    };
  }

  private expiring(env: OfflineTokenEnvelope): boolean {
    return this.now() >= Date.parse(env.accessTokenExpiresAt) - REFRESH_SKEW_MS;
  }

  // Resolve an offline_token to a currently-valid access token. If the cached one is still fresh (or no minter is
  // wired), return it as-is. Otherwise re-mint (deduped per key), persist the rotated envelope via onRefreshed, and
  // return the new access token. Best-effort: a mint failure returns the stale cached token so a provider outage never
  // breaks unrelated dispatches; a persist failure still returns the freshly-minted token (the cache just re-mints next time).
  async resolve(
    key: string,
    env: OfflineTokenEnvelope,
    onRefreshed: (next: OfflineTokenEnvelope) => Promise<void>,
  ): Promise<string> {
    if (!this.minter || !this.expiring(env)) return env.accessToken;
    let mint = this.inflight.get(key);
    if (!mint) {
      const minter = this.minter;
      mint = (async () => {
        const minted = await minter.mint(grantOf(env));
        return {
          ...env,
          refreshToken: minted.refreshToken ?? env.refreshToken,
          accessToken: minted.accessToken,
          accessTokenExpiresAt: minted.expiresAt,
        };
      })();
      this.inflight.set(key, mint);
    }
    try {
      const next = await mint;
      try {
        await onRefreshed(next);
      } catch {
        // best-effort cache write-back — still return the fresh token below
      }
      return next.accessToken;
    } catch {
      return env.accessToken; // provider outage → the last-known access token, never a broken secret map
    } finally {
      this.inflight.delete(key);
    }
  }
}
