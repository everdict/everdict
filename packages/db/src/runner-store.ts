import { randomBytes, randomUUID } from "node:crypto";
import type { SqlClient } from "./client.js";
import { hashKey } from "./tenant-auth.js";

// 셀프호스티드 러너(self-hosted runner) 저장소 — 유저가 자기 머신을 워크스페이스에 페어링한 개인 디바이스.
// Connected accounts(ConnectionStore)와 같은 사상: 개인 소유(owner=principal.subject) + 워크스페이스 가시성
// (페어링된 workspace 기록 → 로스터). 러너는 워크스페이스의 공유 하니스/데이터셋을 "런타임만 바꿔" 자기 머신에서
// 돌리고 결과를 회신한다(설계: docs/architecture/self-hosted-runner.md). 디스패치/리스는 이후 슬라이스.
// 페어링 토큰은 평문 저장 금지 — SHA-256 해시만 보관(tenant API key 와 동일)하고 페어링 시 한 번만 평문 노출.
export interface RunnerMeta {
  id: string;
  label: string; // 표시용 디바이스 이름(예: "ho-macbook")
  os?: string; // linux | darwin | win32 등(선택)
  capabilities: string[]; // repo | browser | os-use | docker — 이 머신이 돌릴 수 있는 환경
  pairedAt: string;
  lastSeenAt?: string; // 마지막 lease/heartbeat 시각(이후 슬라이스에서 touch 로 갱신)
}

// 페어링 입력 — 평문 토큰은 저장 직전 해시. 토큰은 서버가 발급(클라이언트가 정하지 않는다).
export interface PairRunnerInput {
  owner: string; // 러너 소유자 = principal.subject(OIDC sub / api-key 의 key:<ws> / dev 폴백 "dev")
  workspace: string; // 페어링된 워크스페이스 — 로스터(listByWorkspace)용. 소유는 owner.
  label: string;
  os?: string;
  capabilities?: string[];
}

// 페어링 결과 — token 은 평문(한 번만 반환, 저장은 해시). everdict runner 가 이 토큰으로 MCP 에 인증한다(이후 슬라이스).
export interface PairedRunner {
  meta: RunnerMeta;
  token: string;
}

// 토큰 → 러너 식별(이후 슬라이스의 MCP 인증/리스에서 사용). owner/workspace/runnerId 로 해석.
export interface ResolvedRunner {
  owner: string;
  workspace: string;
  runnerId: string;
}

export interface RunnerStore {
  pair(input: PairRunnerInput): Promise<PairedRunner>;
  list(owner: string): Promise<RunnerMeta[]>; // 개인(owner) 메타만
  get(owner: string, id: string): Promise<RunnerMeta | null>; // owner 스코프 단건(소유자 확인 — 디스패치 self: 라우팅)
  listByWorkspace(workspace: string): Promise<RunnerMeta[]>; // 워크스페이스 로스터(메타만)
  remove(owner: string, id: string): Promise<void>; // owner 스코프, 멱등
  touch(owner: string, id: string): Promise<void>; // lastSeenAt 갱신(멱등; 없는 러너면 no-op)
  setCapabilities(owner: string, id: string, capabilities: string[]): Promise<void>; // 러너 자가-광고(docker 등). 멱등; 없는 러너 no-op
  resolveByToken(token: string): Promise<ResolvedRunner | null>; // 토큰 해시로 러너 해석(내부 전용)
}

// rnr_<랜덤> — 평문 페어링 토큰. 발급 시 한 번만 노출되고 저장은 해시만.
export function generateRunnerToken(): string {
  return `rnr_${randomBytes(24).toString("base64url")}`;
}

function metaOf(input: PairRunnerInput, id: string, pairedAt: string): RunnerMeta {
  return {
    id,
    label: input.label,
    capabilities: input.capabilities ?? [],
    pairedAt,
    ...(input.os !== undefined ? { os: input.os } : {}),
  };
}

interface Stored {
  meta: RunnerMeta;
  workspace: string;
  tokenHash: string;
}

export class InMemoryRunnerStore implements RunnerStore {
  private readonly byOwner = new Map<string, Map<string, Stored>>();
  private readonly byTokenHash = new Map<string, { owner: string; id: string }>();
  constructor(private readonly now: () => string = () => new Date().toISOString()) {}
  private forOwner(owner: string) {
    let m = this.byOwner.get(owner);
    if (!m) {
      m = new Map();
      this.byOwner.set(owner, m);
    }
    return m;
  }
  async pair(input: PairRunnerInput): Promise<PairedRunner> {
    const id = randomUUID();
    const token = generateRunnerToken();
    const tokenHash = hashKey(token);
    const meta = metaOf(input, id, this.now());
    this.forOwner(input.owner).set(id, { meta, workspace: input.workspace, tokenHash });
    this.byTokenHash.set(tokenHash, { owner: input.owner, id });
    return { meta, token };
  }
  async list(owner: string): Promise<RunnerMeta[]> {
    return [...(this.byOwner.get(owner)?.values() ?? [])]
      .map((s) => s.meta)
      .sort((a, b) => (a.pairedAt < b.pairedAt ? 1 : -1)); // 최신순
  }
  async get(owner: string, id: string): Promise<RunnerMeta | null> {
    return this.byOwner.get(owner)?.get(id)?.meta ?? null;
  }
  async listByWorkspace(workspace: string): Promise<RunnerMeta[]> {
    return [...this.byOwner.values()]
      .flatMap((m) => [...m.values()])
      .filter((s) => s.workspace === workspace)
      .map((s) => s.meta)
      .sort((a, b) => (a.pairedAt < b.pairedAt ? 1 : -1));
  }
  async remove(owner: string, id: string): Promise<void> {
    const s = this.byOwner.get(owner)?.get(id);
    if (s) this.byTokenHash.delete(s.tokenHash);
    this.byOwner.get(owner)?.delete(id);
  }
  async touch(owner: string, id: string): Promise<void> {
    const s = this.byOwner.get(owner)?.get(id);
    if (s) s.meta = { ...s.meta, lastSeenAt: this.now() };
  }
  async setCapabilities(owner: string, id: string, capabilities: string[]): Promise<void> {
    const s = this.byOwner.get(owner)?.get(id);
    if (s) s.meta = { ...s.meta, capabilities };
  }
  async resolveByToken(token: string): Promise<ResolvedRunner | null> {
    const hit = this.byTokenHash.get(hashKey(token));
    if (!hit) return null;
    const s = this.byOwner.get(hit.owner)?.get(hit.id);
    if (!s) return null;
    return { owner: hit.owner, workspace: s.workspace, runnerId: hit.id };
  }
}

interface RunnerRow {
  id: string;
  label: string;
  os: string | null;
  capabilities: string;
  paired_at: string | Date;
  last_seen_at: string | Date | null;
}

function rowToMeta(r: RunnerRow): RunnerMeta {
  return {
    id: r.id,
    label: r.label,
    capabilities: r.capabilities.split(/\s+/).filter(Boolean), // 공백 구분
    pairedAt: new Date(r.paired_at).toISOString(),
    ...(r.os !== null ? { os: r.os } : {}),
    ...(r.last_seen_at !== null ? { lastSeenAt: new Date(r.last_seen_at).toISOString() } : {}),
  };
}

export class PgRunnerStore implements RunnerStore {
  constructor(private readonly client: SqlClient) {}
  async pair(input: PairRunnerInput): Promise<PairedRunner> {
    const id = randomUUID();
    const token = generateRunnerToken();
    const res = await this.client.query<{ paired_at: string | Date }>(
      `INSERT INTO everdict_runners (owner, id, workspace, label, os, capabilities, token_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING paired_at`,
      [
        input.owner,
        id,
        input.workspace,
        input.label,
        input.os ?? null,
        (input.capabilities ?? []).join(" "),
        hashKey(token),
      ],
    );
    const r = res.rows[0];
    if (!r) throw new Error("runner insert 가 행을 돌려주지 않았습니다.");
    return { meta: metaOf(input, id, new Date(r.paired_at).toISOString()), token };
  }
  async list(owner: string): Promise<RunnerMeta[]> {
    // token_hash 는 절대 select 하지 않는다.
    const res = await this.client.query<RunnerRow>(
      `SELECT id, label, os, capabilities, paired_at, last_seen_at
       FROM everdict_runners WHERE owner = $1 ORDER BY paired_at DESC`,
      [owner],
    );
    return res.rows.map(rowToMeta);
  }
  async get(owner: string, id: string): Promise<RunnerMeta | null> {
    const res = await this.client.query<RunnerRow>(
      `SELECT id, label, os, capabilities, paired_at, last_seen_at
       FROM everdict_runners WHERE owner = $1 AND id = $2`,
      [owner, id],
    );
    const r = res.rows[0];
    return r ? rowToMeta(r) : null;
  }
  async listByWorkspace(workspace: string): Promise<RunnerMeta[]> {
    const res = await this.client.query<RunnerRow>(
      `SELECT id, label, os, capabilities, paired_at, last_seen_at
       FROM everdict_runners WHERE workspace = $1 ORDER BY paired_at DESC`,
      [workspace],
    );
    return res.rows.map(rowToMeta);
  }
  async remove(owner: string, id: string): Promise<void> {
    await this.client.query("DELETE FROM everdict_runners WHERE owner = $1 AND id = $2", [owner, id]);
  }
  async touch(owner: string, id: string): Promise<void> {
    await this.client.query("UPDATE everdict_runners SET last_seen_at = now() WHERE owner = $1 AND id = $2", [
      owner,
      id,
    ]);
  }
  async setCapabilities(owner: string, id: string, capabilities: string[]): Promise<void> {
    await this.client.query("UPDATE everdict_runners SET capabilities = $3 WHERE owner = $1 AND id = $2", [
      owner,
      id,
      capabilities.join(" "),
    ]);
  }
  async resolveByToken(token: string): Promise<ResolvedRunner | null> {
    const res = await this.client.query<{ owner: string; workspace: string; id: string }>(
      "SELECT owner, workspace, id FROM everdict_runners WHERE token_hash = $1",
      [hashKey(token)],
    );
    const r = res.rows[0];
    if (!r) return null;
    return { owner: r.owner, workspace: r.workspace, runnerId: r.id };
  }
}
