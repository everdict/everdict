import type { SqlClient } from "./client.js";
import type { EncryptedSecret, SecretCipher } from "./secret-cipher.js";

// 워크스페이스 시크릿 저장소 — 여러 모델/프로바이더 키(OPENAI_API_KEY, ANTHROPIC_API_KEY, LiteLLM 키 등)를
// 워크스페이스별로 관리. 값은 AES-GCM 으로 at-rest 암호화되며 절대 평문으로 되돌려주지 않는다(list 는 이름만).
// entries() 만 복호화 — 디스패치 시 그 워크스페이스의 잡 env 주입에만 사용(SecretProvider 경유).
export interface SecretMeta {
  name: string;
  updatedAt: string;
}

export interface SecretStore {
  set(workspace: string, name: string, value: string): Promise<void>;
  list(workspace: string): Promise<SecretMeta[]>; // 이름 + 메타만(값 없음)
  remove(workspace: string, name: string): Promise<void>;
  entries(workspace: string): Promise<Record<string, string>>; // 복호화 — 주입 전용(서버 내부)
}

export class InMemorySecretStore implements SecretStore {
  private readonly byWs = new Map<string, Map<string, { enc: EncryptedSecret; updatedAt: string }>>();
  constructor(
    private readonly cipher: SecretCipher,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}
  private ws(workspace: string) {
    let m = this.byWs.get(workspace);
    if (!m) {
      m = new Map();
      this.byWs.set(workspace, m);
    }
    return m;
  }
  async set(workspace: string, name: string, value: string): Promise<void> {
    this.ws(workspace).set(name, { enc: this.cipher.encrypt(value), updatedAt: this.now() });
  }
  async list(workspace: string): Promise<SecretMeta[]> {
    return [...(this.byWs.get(workspace)?.entries() ?? [])]
      .map(([name, v]) => ({ name, updatedAt: v.updatedAt }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  async remove(workspace: string, name: string): Promise<void> {
    this.byWs.get(workspace)?.delete(name);
  }
  async entries(workspace: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const [name, v] of this.byWs.get(workspace)?.entries() ?? []) out[name] = this.cipher.decrypt(v.enc);
    return out;
  }
}

interface SecretRow {
  name: string;
  ciphertext: string;
  iv: string;
  tag: string;
  updated_at: string;
}

export class PgSecretStore implements SecretStore {
  constructor(
    private readonly client: SqlClient,
    private readonly cipher: SecretCipher,
  ) {}
  async set(workspace: string, name: string, value: string): Promise<void> {
    const { ciphertext, iv, tag } = this.cipher.encrypt(value);
    await this.client.query(
      `INSERT INTO assay_secrets (workspace, name, ciphertext, iv, tag, updated_at) VALUES ($1,$2,$3,$4,$5, now())
       ON CONFLICT (workspace, name) DO UPDATE SET ciphertext = $3, iv = $4, tag = $5, updated_at = now()`,
      [workspace, name, ciphertext, iv, tag],
    );
  }
  async list(workspace: string): Promise<SecretMeta[]> {
    const r = await this.client.query<{ name: string; updated_at: string }>(
      "SELECT name, updated_at FROM assay_secrets WHERE workspace = $1 ORDER BY name",
      [workspace],
    );
    return r.rows.map((x) => ({ name: x.name, updatedAt: x.updated_at }));
  }
  async remove(workspace: string, name: string): Promise<void> {
    await this.client.query("DELETE FROM assay_secrets WHERE workspace = $1 AND name = $2", [workspace, name]);
  }
  async entries(workspace: string): Promise<Record<string, string>> {
    const r = await this.client.query<SecretRow>(
      "SELECT name, ciphertext, iv, tag FROM assay_secrets WHERE workspace = $1",
      [workspace],
    );
    const out: Record<string, string> = {};
    for (const row of r.rows)
      out[row.name] = this.cipher.decrypt({ ciphertext: row.ciphertext, iv: row.iv, tag: row.tag });
    return out;
  }
}
