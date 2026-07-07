import { randomBytes } from "node:crypto";
import type { SqlClient } from "./client.js";

// Single-use pending-state store between OAuth authorize→callback (CSRF + callback-context restore).
// put on start, take on callback (single-use — consumed and deleted). Expired ones are null. self-hosted (GHE/Mattermost)
// carries host + clientId (public) + clientSecretName (a SecretStore key name — not the value) to re-resolve the credentials in the callback.
export interface OAuthStatePending {
  workspace: string;
  provider: string;
  host?: string;
  clientId?: string; // self-hosted OAuth app client_id (public)
  clientSecretName?: string; // SecretStore key name of the self-hosted client_secret (not the value)
  createdBy: string;
}

export interface OAuthStateStore {
  put(state: string, pending: OAuthStatePending, expiresAt: string): Promise<void>;
  take(state: string): Promise<OAuthStatePending | null>; // single-use — deleted on consume. null if absent/expired.
}

// An unguessable state nonce. Goes out as the authorize URL's state parameter and comes back as-is in the callback.
export function generateOAuthState(): string {
  return randomBytes(24).toString("base64url");
}

function pending(r: StateRow): OAuthStatePending {
  return {
    workspace: r.workspace,
    provider: r.provider,
    createdBy: r.created_by,
    ...(r.host !== null ? { host: r.host } : {}),
    ...(r.client_id !== null ? { clientId: r.client_id } : {}),
    ...(r.client_secret_name !== null ? { clientSecretName: r.client_secret_name } : {}),
  };
}

interface StateRow {
  workspace: string;
  provider: string;
  host: string | null;
  client_id: string | null;
  client_secret_name: string | null;
  created_by: string;
  expires_at: string | Date;
}

export class InMemoryOAuthStateStore implements OAuthStateStore {
  private readonly byState = new Map<string, { pending: OAuthStatePending; expiresAt: string }>();
  constructor(private readonly now: () => string = () => new Date().toISOString()) {}
  async put(state: string, p: OAuthStatePending, expiresAt: string): Promise<void> {
    this.byState.set(state, { pending: p, expiresAt });
  }
  async take(state: string): Promise<OAuthStatePending | null> {
    const row = this.byState.get(state);
    if (!row) return null;
    this.byState.delete(state); // single-use
    if (row.expiresAt <= this.now()) return null; // expired (already consumed)
    return row.pending;
  }
}

export class PgOAuthStateStore implements OAuthStateStore {
  constructor(private readonly client: SqlClient) {}
  async put(state: string, p: OAuthStatePending, expiresAt: string): Promise<void> {
    await this.client.query(
      `INSERT INTO everdict_oauth_states
         (state, workspace, provider, host, client_id, client_secret_name, created_by, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        state,
        p.workspace,
        p.provider,
        p.host ?? null,
        p.clientId ?? null,
        p.clientSecretName ?? null,
        p.createdBy,
        expiresAt,
      ],
    );
  }
  async take(state: string): Promise<OAuthStatePending | null> {
    // DELETE … RETURNING = atomic single-use consume (expired ones are deleted too → self-cleaning). Expiry is judged in the app.
    const res = await this.client.query<StateRow>(
      `DELETE FROM everdict_oauth_states WHERE state = $1
       RETURNING workspace, provider, host, client_id, client_secret_name, created_by, expires_at`,
      [state],
    );
    const r = res.rows[0];
    if (!r) return null;
    if (new Date(r.expires_at).getTime() <= Date.now()) return null;
    return pending(r);
  }
}
