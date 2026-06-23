import type { SqlClient } from "./client.js";

// 유저 프로필 — Keycloak(OIDC) 신원에 덧입히는 가변 표시 정보(이름/유저네임/아바타). subject(=sub)가 키.
// email 은 여기 두지 않는다 — SSO 클레임(표시 전용·읽기전용)이라 Principal 에서만 온다. 이 스토어는
// 컨트롤플레인이 소유하는 가변 프로필(Linear 식): 사람이 자기 표시 정보를 직접 수정한다(authz 무관).
export interface UserProfile {
  subject: string;
  name?: string;
  username?: string;
  avatarUrl?: string;
  updatedAt: string;
}

// 부분 갱신. 키가 없으면 그대로 두고, null 이면 그 필드를 지운다, 문자열이면 설정한다.
export interface UserProfilePatch {
  name?: string | null;
  username?: string | null;
  avatarUrl?: string | null;
}

export interface UserProfileStore {
  get(subject: string): Promise<UserProfile | undefined>;
  // 여러 subject 의 프로필을 한 번에(멤버 목록을 이름/아바타로 보강하는 용도). 프로필이 없는 subject 는 결과에서 누락.
  getMany(subjects: string[]): Promise<UserProfile[]>;
  upsert(subject: string, patch: UserProfilePatch): Promise<UserProfile>;
}

function nowIso(): string {
  return new Date().toISOString();
}

// patch 필드 적용: undefined=유지, null=지움(undefined), 문자열=설정.
function applyField(current: string | undefined, incoming: string | null | undefined): string | undefined {
  if (incoming === undefined) return current;
  if (incoming === null) return undefined;
  return incoming;
}

function build(subject: string, name?: string, username?: string, avatarUrl?: string): UserProfile {
  return {
    subject,
    updatedAt: nowIso(),
    ...(name !== undefined ? { name } : {}),
    ...(username !== undefined ? { username } : {}),
    ...(avatarUrl !== undefined ? { avatarUrl } : {}),
  };
}

export class InMemoryUserProfileStore implements UserProfileStore {
  private readonly rows = new Map<string, UserProfile>();

  async get(subject: string): Promise<UserProfile | undefined> {
    return this.rows.get(subject);
  }

  async getMany(subjects: string[]): Promise<UserProfile[]> {
    const out: UserProfile[] = [];
    for (const s of subjects) {
      const row = this.rows.get(s);
      if (row) out.push(row);
    }
    return out;
  }

  async upsert(subject: string, patch: UserProfilePatch): Promise<UserProfile> {
    const cur = this.rows.get(subject);
    const next = build(
      subject,
      applyField(cur?.name, patch.name),
      applyField(cur?.username, patch.username),
      applyField(cur?.avatarUrl, patch.avatarUrl),
    );
    this.rows.set(subject, next);
    return next;
  }
}

interface ProfileRow {
  subject: string;
  name: string | null;
  username: string | null;
  avatar_url: string | null;
  updated_at: string | Date;
}

function toProfile(row: ProfileRow): UserProfile {
  return build(row.subject, row.name ?? undefined, row.username ?? undefined, row.avatar_url ?? undefined);
}

export class PgUserProfileStore implements UserProfileStore {
  constructor(private readonly client: SqlClient) {}

  async get(subject: string): Promise<UserProfile | undefined> {
    const res = await this.client.query<ProfileRow>(
      "SELECT subject, name, username, avatar_url, updated_at FROM assay_user_profiles WHERE subject = $1",
      [subject],
    );
    const row = res.rows[0];
    return row ? toProfile(row) : undefined;
  }

  async getMany(subjects: string[]): Promise<UserProfile[]> {
    if (subjects.length === 0) return [];
    const res = await this.client.query<ProfileRow>(
      "SELECT subject, name, username, avatar_url, updated_at FROM assay_user_profiles WHERE subject = ANY($1)",
      [subjects],
    );
    return res.rows.map(toProfile);
  }

  async upsert(subject: string, patch: UserProfilePatch): Promise<UserProfile> {
    // read-merge-write — undefined=유지, null=지움 의 3-상태 병합을 동적 SQL 없이 처리.
    const cur = await this.get(subject);
    const name = applyField(cur?.name, patch.name) ?? null;
    const username = applyField(cur?.username, patch.username) ?? null;
    const avatarUrl = applyField(cur?.avatarUrl, patch.avatarUrl) ?? null;
    await this.client.query(
      `INSERT INTO assay_user_profiles (subject, name, username, avatar_url) VALUES ($1, $2, $3, $4)
       ON CONFLICT (subject) DO UPDATE SET name = EXCLUDED.name, username = EXCLUDED.username,
         avatar_url = EXCLUDED.avatar_url, updated_at = now()`,
      [subject, name, username, avatarUrl],
    );
    return build(subject, name ?? undefined, username ?? undefined, avatarUrl ?? undefined);
  }
}
