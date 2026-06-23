import { randomBytes } from "node:crypto";
import type { SqlClient } from "./client.js";

// OAuth authorize→callback 사이의 1회용 pending state 저장소(CSRF + 콜백 컨텍스트 복원).
// start 시 put, callback 시 take(1회용 — 소비하며 삭제). 만료된 건 null. self-hosted(GHE/Mattermost)는
// host + clientId(공개값) + clientSecretName(SecretStore 키 이름 — 값 아님)을 운반해 callback 에서 자격증명 재해석.
export interface OAuthStatePending {
  workspace: string;
  provider: string;
  host?: string;
  clientId?: string; // self-hosted OAuth app client_id(공개값)
  clientSecretName?: string; // self-hosted client_secret 의 SecretStore 키 이름(값 아님)
  createdBy: string;
}

export interface OAuthStateStore {
  put(state: string, pending: OAuthStatePending, expiresAt: string): Promise<void>;
  take(state: string): Promise<OAuthStatePending | null>; // 1회용 — 소비 시 삭제. 없음/만료면 null.
}

// 추측 불가한 state nonce. authorize URL 의 state 파라미터로 나가고 callback 에서 그대로 돌아온다.
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
    this.byState.delete(state); // 1회용
    if (row.expiresAt <= this.now()) return null; // 만료(이미 소비됨)
    return row.pending;
  }
}

export class PgOAuthStateStore implements OAuthStateStore {
  constructor(private readonly client: SqlClient) {}
  async put(state: string, p: OAuthStatePending, expiresAt: string): Promise<void> {
    await this.client.query(
      `INSERT INTO assay_oauth_states
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
    // DELETE … RETURNING = 원자적 1회용 소비(만료 건도 삭제 → 자가 청소). 만료는 앱에서 판정.
    const res = await this.client.query<StateRow>(
      `DELETE FROM assay_oauth_states WHERE state = $1
       RETURNING workspace, provider, host, client_id, client_secret_name, created_by, expires_at`,
      [state],
    );
    const r = res.rows[0];
    if (!r) return null;
    if (new Date(r.expires_at).getTime() <= Date.now()) return null;
    return pending(r);
  }
}
