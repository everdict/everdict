import { randomUUID } from "node:crypto";
import type { SqlClient } from "./client.js";
import type { EncryptedSecret, SecretCipher } from "./secret-cipher.js";

// 외부 계정 연결(Connected accounts) 저장소 — GitHub/GHE/Mattermost OAuth 토큰을 개인(owner=principal.subject)별로 보관.
// 개인 소유 + 워크스페이스 가시성: 연결은 owner 가 소유하고(account 페이지에서 list/connect/disconnect),
// 만들어진 workspace 도 기록해 워크스페이스 애플리케이션 로스터(설정>멤버 탭, listByWorkspace)에 읽기 전용으로 노출한다.
// SecretStore 와 동일 사상: 토큰(access/refresh)은 AES-GCM at-rest 암호화하고 list 는 메타만(토큰 절대 미반환).
// tokenFor() 만 복호화 — 서버 내부(harness clone / image pull / notify)에서만 사용한다.
export interface ConnectionMeta {
  id: string;
  provider: string; // "github" | "github-enterprise" | "mattermost"
  host?: string; // self-hosted 호스트(GHE/Mattermost). github.com 은 생략.
  accountLabel: string; // 표시용 계정 식별자(예: github login)
  scopes: string[];
  connectedAt: string;
}

// 토큰 교환 후 서비스가 저장을 요청할 때 넘기는 입력(평문 토큰 포함 — 저장 직전 암호화).
export interface CreateConnectionInput {
  owner: string; // 연결 소유자 = principal.subject(OIDC sub / api-key 의 key:<ws> / dev 폴백 "dev")
  workspace: string; // 연결이 만들어진 워크스페이스 — 워크스페이스 애플리케이션 로스터(listByWorkspace)용. 소유는 owner.
  provider: string;
  host?: string;
  accountLabel: string;
  scopes: string[];
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string; // access token 만료(있으면) — 갱신 판단용
}

// 복호화된 토큰 — 주입 전용(서버 내부). 클라이언트로 절대 흘러나가지 않는다.
export interface ConnectionToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
}

export interface ConnectionStore {
  create(input: CreateConnectionInput): Promise<ConnectionMeta>;
  list(owner: string): Promise<ConnectionMeta[]>; // 개인(owner) 메타만(토큰 없음)
  listByWorkspace(workspace: string): Promise<ConnectionMeta[]>; // 워크스페이스 로스터(메타만) — 만들어진 워크스페이스 기준
  remove(owner: string, id: string): Promise<void>; // owner 스코프, 멱등
  tokenFor(owner: string, id: string): Promise<ConnectionToken | null>; // 복호화 — 내부 전용
}

interface Stored {
  meta: ConnectionMeta;
  workspace: string; // 로스터(listByWorkspace) 필터용
  access: EncryptedSecret;
  refresh?: EncryptedSecret;
  expiresAt?: string;
}

function meta(input: CreateConnectionInput, id: string, connectedAt: string): ConnectionMeta {
  return {
    id,
    provider: input.provider,
    accountLabel: input.accountLabel,
    scopes: input.scopes,
    connectedAt,
    ...(input.host !== undefined ? { host: input.host } : {}),
  };
}

export class InMemoryConnectionStore implements ConnectionStore {
  private readonly byOwner = new Map<string, Map<string, Stored>>();
  constructor(
    private readonly cipher: SecretCipher,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}
  private forOwner(owner: string) {
    let m = this.byOwner.get(owner);
    if (!m) {
      m = new Map();
      this.byOwner.set(owner, m);
    }
    return m;
  }
  async create(input: CreateConnectionInput): Promise<ConnectionMeta> {
    const id = randomUUID();
    const m = meta(input, id, this.now());
    this.forOwner(input.owner).set(id, {
      meta: m,
      workspace: input.workspace,
      access: this.cipher.encrypt(input.accessToken),
      ...(input.refreshToken !== undefined ? { refresh: this.cipher.encrypt(input.refreshToken) } : {}),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    });
    return m;
  }
  async list(owner: string): Promise<ConnectionMeta[]> {
    return [...(this.byOwner.get(owner)?.values() ?? [])]
      .map((s) => s.meta)
      .sort((a, b) => (a.connectedAt < b.connectedAt ? 1 : -1)); // 최신순
  }
  async listByWorkspace(workspace: string): Promise<ConnectionMeta[]> {
    // 모든 owner 의 연결을 훑어 만들어진 워크스페이스가 일치하는 것만(읽기 전용 로스터).
    return [...this.byOwner.values()]
      .flatMap((m) => [...m.values()])
      .filter((s) => s.workspace === workspace)
      .map((s) => s.meta)
      .sort((a, b) => (a.connectedAt < b.connectedAt ? 1 : -1)); // 최신순
  }
  async remove(owner: string, id: string): Promise<void> {
    this.byOwner.get(owner)?.delete(id);
  }
  async tokenFor(owner: string, id: string): Promise<ConnectionToken | null> {
    const s = this.byOwner.get(owner)?.get(id);
    if (!s) return null;
    return {
      accessToken: this.cipher.decrypt(s.access),
      ...(s.refresh !== undefined ? { refreshToken: this.cipher.decrypt(s.refresh) } : {}),
      ...(s.expiresAt !== undefined ? { expiresAt: s.expiresAt } : {}),
    };
  }
}

interface ConnectionRow {
  id: string;
  provider: string;
  host: string | null;
  account_label: string;
  scopes: string;
  connected_at: string | Date;
}

interface TokenRow {
  ciphertext: string;
  iv: string;
  tag: string;
  refresh_ciphertext: string | null;
  refresh_iv: string | null;
  refresh_tag: string | null;
  expires_at: string | Date | null;
}

function rowToMeta(r: ConnectionRow): ConnectionMeta {
  return {
    id: r.id,
    provider: r.provider,
    accountLabel: r.account_label,
    scopes: r.scopes.split(/\s+/).filter(Boolean), // OAuth scope = 공백 구분
    connectedAt: new Date(r.connected_at).toISOString(),
    ...(r.host !== null ? { host: r.host } : {}),
  };
}

export class PgConnectionStore implements ConnectionStore {
  constructor(
    private readonly client: SqlClient,
    private readonly cipher: SecretCipher,
  ) {}
  async create(input: CreateConnectionInput): Promise<ConnectionMeta> {
    const id = randomUUID();
    const access = this.cipher.encrypt(input.accessToken);
    const refresh = input.refreshToken !== undefined ? this.cipher.encrypt(input.refreshToken) : null;
    const res = await this.client.query<{ connected_at: string | Date }>(
      `INSERT INTO assay_connections
         (owner, workspace, id, provider, host, account_label, scopes,
          ciphertext, iv, tag, refresh_ciphertext, refresh_iv, refresh_tag, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING connected_at`,
      [
        input.owner,
        input.workspace,
        id,
        input.provider,
        input.host ?? null,
        input.accountLabel,
        input.scopes.join(" "),
        access.ciphertext,
        access.iv,
        access.tag,
        refresh?.ciphertext ?? null,
        refresh?.iv ?? null,
        refresh?.tag ?? null,
        input.expiresAt ?? null,
      ],
    );
    const r = res.rows[0];
    if (!r) throw new Error("connection insert 가 행을 돌려주지 않았습니다.");
    return meta(input, id, new Date(r.connected_at).toISOString());
  }
  async list(owner: string): Promise<ConnectionMeta[]> {
    // 토큰 컬럼은 select 하지 않는다(절대 노출 금지).
    const res = await this.client.query<ConnectionRow>(
      `SELECT id, provider, host, account_label, scopes, connected_at
       FROM assay_connections WHERE owner = $1 ORDER BY connected_at DESC`,
      [owner],
    );
    return res.rows.map(rowToMeta);
  }
  async remove(owner: string, id: string): Promise<void> {
    await this.client.query("DELETE FROM assay_connections WHERE owner = $1 AND id = $2", [owner, id]);
  }
  async tokenFor(owner: string, id: string): Promise<ConnectionToken | null> {
    const res = await this.client.query<TokenRow>(
      `SELECT ciphertext, iv, tag, refresh_ciphertext, refresh_iv, refresh_tag, expires_at
       FROM assay_connections WHERE owner = $1 AND id = $2`,
      [owner, id],
    );
    const r = res.rows[0];
    if (!r) return null;
    // null 체크를 한 식 안에서 — TS 가 string 으로 좁혀 캐스트 불필요.
    const refresh =
      r.refresh_ciphertext !== null && r.refresh_iv !== null && r.refresh_tag !== null
        ? this.cipher.decrypt({ ciphertext: r.refresh_ciphertext, iv: r.refresh_iv, tag: r.refresh_tag })
        : undefined;
    return {
      accessToken: this.cipher.decrypt({ ciphertext: r.ciphertext, iv: r.iv, tag: r.tag }),
      ...(refresh !== undefined ? { refreshToken: refresh } : {}),
      ...(r.expires_at !== null ? { expiresAt: new Date(r.expires_at).toISOString() } : {}),
    };
  }
}
