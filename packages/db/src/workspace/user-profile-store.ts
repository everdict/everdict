import type { UserProfile, UserProfilePatch } from "@everdict/contracts";
import type { SqlClient } from "../client.js";

// User profile — mutable display info (name/username/avatar) layered on top of the Keycloak (OIDC) identity. subject (=sub) is the key.
// email is not kept here — it's an SSO claim (display-only/read-only), so it comes only from the Principal. This store is
// a mutable profile owned by the control plane (Linear-style): a person edits their own display info directly (no authz bearing).

import type { UserProfileStore } from "@everdict/application-control";

function nowIso(): string {
  return new Date().toISOString();
}

// Apply a patch field: undefined=keep, null=clear (undefined), string=set.
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
      "SELECT subject, name, username, avatar_url, updated_at FROM everdict_user_profiles WHERE subject = $1",
      [subject],
    );
    const row = res.rows[0];
    return row ? toProfile(row) : undefined;
  }

  async getMany(subjects: string[]): Promise<UserProfile[]> {
    if (subjects.length === 0) return [];
    const res = await this.client.query<ProfileRow>(
      "SELECT subject, name, username, avatar_url, updated_at FROM everdict_user_profiles WHERE subject = ANY($1)",
      [subjects],
    );
    return res.rows.map(toProfile);
  }

  async upsert(subject: string, patch: UserProfilePatch): Promise<UserProfile> {
    // read-merge-write — handles the 3-state merge (undefined=keep, null=clear) without dynamic SQL.
    const cur = await this.get(subject);
    const name = applyField(cur?.name, patch.name) ?? null;
    const username = applyField(cur?.username, patch.username) ?? null;
    const avatarUrl = applyField(cur?.avatarUrl, patch.avatarUrl) ?? null;
    await this.client.query(
      `INSERT INTO everdict_user_profiles (subject, name, username, avatar_url) VALUES ($1, $2, $3, $4)
       ON CONFLICT (subject) DO UPDATE SET name = EXCLUDED.name, username = EXCLUDED.username,
         avatar_url = EXCLUDED.avatar_url, updated_at = now()`,
      [subject, name, username, avatarUrl],
    );
    return build(subject, name ?? undefined, username ?? undefined, avatarUrl ?? undefined);
  }
}
