import type { OfflineTokenMinter, SecretStore } from "@everdict/application-control";
import {
  InternalError,
  type OfflineTokenGrant,
  type ScopedSecretEntries,
  type SecretKind,
  type SecretMeta,
} from "@everdict/contracts";
import type { SqlClient } from "../client.js";
import { OfflineTokenManager, decodeEnvelope, encodeEnvelope } from "./offline-token.js";
import type { EncryptedSecret, SecretCipher } from "./secret-cipher.js";

// Workspace secret store — manages model/provider keys (OPENAI_API_KEY etc.) per scope.
// scope: "workspace" (owner='') = shared (admin-managed) · "user" (owner=subject) = that user's personal (self-managed, invisible to others).
// Values are AES-GCM encrypted at rest and never returned as plaintext (list has only name+scope). Only entries/scopedEntries decrypt (injection-only).
//
// Two kinds: "plain" (set) and "offline_token" (setOfflineToken) — the latter stores a long-lived OAuth refresh token
// (as an encrypted JSON envelope) and, on read, resolves it to a *freshly-minted access token* via the injected
// OfflineTokenManager (auto-refreshed before it lapses). So entries/scopedEntries always yield usable injection values.

// Free-text kind column → the SecretKind union (total: anything but the known offline kind is a plain string).
function secretKind(raw: string): SecretKind {
  return raw === "offline_token" ? "offline_token" : "plain";
}

interface MemRow {
  enc: EncryptedSecret;
  updatedAt: string;
  workspace: string;
  owner: string;
  name: string;
  kind: SecretKind;
  accessTokenExpiresAt?: string; // offline_token only — mirrors the envelope's copy for list-display without decrypting
}

export class InMemorySecretStore implements SecretStore {
  private readonly rows = new Map<string, MemRow>();
  private readonly offline: OfflineTokenManager;
  constructor(
    private readonly cipher: SecretCipher,
    private readonly now: () => string = () => new Date().toISOString(),
    minter?: OfflineTokenMinter,
    clock: () => number = () => Date.now(),
  ) {
    this.offline = new OfflineTokenManager(minter, clock);
  }
  private key(workspace: string, owner: string, name: string): string {
    return `${workspace} ${owner} ${name}`;
  }
  async set(workspace: string, name: string, value: string, owner = ""): Promise<void> {
    this.rows.set(this.key(workspace, owner, name), {
      enc: this.cipher.encrypt(value),
      updatedAt: this.now(),
      workspace,
      owner,
      name,
      kind: "plain",
    });
  }
  async setOfflineToken(workspace: string, name: string, grant: OfflineTokenGrant, owner = ""): Promise<SecretMeta> {
    const env = await this.offline.mintInitial(grant);
    const updatedAt = this.now();
    this.rows.set(this.key(workspace, owner, name), {
      enc: this.cipher.encrypt(encodeEnvelope(env)),
      updatedAt,
      workspace,
      owner,
      name,
      kind: "offline_token",
      accessTokenExpiresAt: env.accessTokenExpiresAt,
    });
    return {
      name,
      updatedAt,
      scope: owner === "" ? "workspace" : "user",
      kind: "offline_token",
      accessTokenExpiresAt: env.accessTokenExpiresAt,
    };
  }
  async list(workspace: string, subject?: string): Promise<SecretMeta[]> {
    const metas: SecretMeta[] = [];
    for (const r of this.rows.values()) {
      if (r.workspace !== workspace) continue;
      const scope: SecretMeta["scope"] = r.owner === "" ? "workspace" : "user";
      if (r.owner !== "" && r.owner !== subject) continue; // shared, or the caller's own personal
      metas.push({
        name: r.name,
        updatedAt: r.updatedAt,
        scope,
        kind: r.kind,
        ...(r.accessTokenExpiresAt ? { accessTokenExpiresAt: r.accessTokenExpiresAt } : {}),
      });
    }
    // Shared first, then personal — name-sorted within each scope.
    return metas.sort((a, b) =>
      a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope === "workspace" ? -1 : 1,
    );
  }
  async remove(workspace: string, name: string, owner = ""): Promise<void> {
    this.rows.delete(this.key(workspace, owner, name));
  }
  // Turn a stored row into its injected value: a plain decrypt, or (offline_token) a currently-valid access token.
  private async resolveValue(r: MemRow): Promise<string> {
    if (r.kind !== "offline_token") return this.cipher.decrypt(r.enc);
    const env = decodeEnvelope(this.cipher.decrypt(r.enc));
    const key = this.key(r.workspace, r.owner, r.name);
    return this.offline.resolve(key, env, async (next) => {
      const cur = this.rows.get(key);
      if (cur)
        this.rows.set(key, {
          ...cur,
          enc: this.cipher.encrypt(encodeEnvelope(next)),
          accessTokenExpiresAt: next.accessTokenExpiresAt,
        });
    });
  }
  async entries(workspace: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const r of [...this.rows.values()]) {
      if (r.workspace !== workspace || r.owner !== "") continue;
      try {
        out[r.name] = await this.resolveValue(r);
      } catch {
        // a corrupt/unusable offline_token is skipped rather than breaking the whole injection map (the referencing case fails in isolation)
      }
    }
    return out;
  }
  async scopedEntries(workspace: string, subject: string): Promise<ScopedSecretEntries> {
    const workspaceEntries: Record<string, string> = {};
    const user: Record<string, string> = {};
    for (const r of [...this.rows.values()]) {
      if (r.workspace !== workspace) continue;
      if (r.owner !== "" && r.owner !== subject) continue;
      try {
        const value = await this.resolveValue(r);
        if (r.owner === "") workspaceEntries[r.name] = value;
        else user[r.name] = value;
      } catch {
        // skip an unusable offline_token (see entries)
      }
    }
    return { workspace: workspaceEntries, user };
  }
}

interface SecretRow {
  name: string;
  owner: string;
  ciphertext: string;
  iv: string;
  tag: string;
  kind: string;
}

export class PgSecretStore implements SecretStore {
  private readonly offline: OfflineTokenManager;
  constructor(
    private readonly client: SqlClient,
    private readonly cipher: SecretCipher,
    minter?: OfflineTokenMinter,
    clock: () => number = () => Date.now(),
  ) {
    this.offline = new OfflineTokenManager(minter, clock);
  }
  async set(workspace: string, name: string, value: string, owner = ""): Promise<void> {
    const { ciphertext, iv, tag } = this.cipher.encrypt(value);
    await this.client.query(
      `INSERT INTO everdict_secrets (workspace, owner, name, ciphertext, iv, tag, kind, access_token_expires_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'plain',NULL, now())
       ON CONFLICT (workspace, owner, name) DO UPDATE SET ciphertext = $4, iv = $5, tag = $6, kind = 'plain', access_token_expires_at = NULL, updated_at = now()`,
      [workspace, owner, name, ciphertext, iv, tag],
    );
  }
  async setOfflineToken(workspace: string, name: string, grant: OfflineTokenGrant, owner = ""): Promise<SecretMeta> {
    const env = await this.offline.mintInitial(grant);
    const { ciphertext, iv, tag } = this.cipher.encrypt(encodeEnvelope(env));
    const r = await this.client.query<{ updated_at: string }>(
      `INSERT INTO everdict_secrets (workspace, owner, name, ciphertext, iv, tag, kind, access_token_expires_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'offline_token',$7, now())
       ON CONFLICT (workspace, owner, name) DO UPDATE SET ciphertext = $4, iv = $5, tag = $6, kind = 'offline_token', access_token_expires_at = $7, updated_at = now()
       RETURNING updated_at`,
      [workspace, owner, name, ciphertext, iv, tag, env.accessTokenExpiresAt],
    );
    const row = r.rows[0];
    if (!row)
      throw new InternalError("UPSTREAM_MISCONFIGURED", { workspace, name }, "offline-token upsert returned no row");
    return {
      name,
      updatedAt: row.updated_at,
      scope: owner === "" ? "workspace" : "user",
      kind: "offline_token",
      accessTokenExpiresAt: env.accessTokenExpiresAt,
    };
  }
  async list(workspace: string, subject?: string): Promise<SecretMeta[]> {
    // owner='' (shared) + owner=subject (personal). No subject → shared only ($2='').
    const r = await this.client.query<{
      name: string;
      owner: string;
      updated_at: string;
      kind: string;
      access_token_expires_at: string | null;
    }>(
      "SELECT name, owner, updated_at, kind, access_token_expires_at FROM everdict_secrets WHERE workspace = $1 AND (owner = '' OR owner = $2) ORDER BY owner, name",
      [workspace, subject ?? ""],
    );
    return r.rows.map((x) => ({
      name: x.name,
      updatedAt: x.updated_at,
      scope: x.owner === "" ? "workspace" : "user",
      kind: secretKind(x.kind),
      ...(x.access_token_expires_at ? { accessTokenExpiresAt: x.access_token_expires_at } : {}),
    }));
  }
  async remove(workspace: string, name: string, owner = ""): Promise<void> {
    await this.client.query("DELETE FROM everdict_secrets WHERE workspace = $1 AND owner = $2 AND name = $3", [
      workspace,
      owner,
      name,
    ]);
  }
  // Decrypt a row to its injected value: plain text, or (offline_token) a refreshed-as-needed access token. A refresh
  // persists the rotated envelope back to the row (write-on-read cache); best-effort, never bumps updated_at.
  private async resolveRow(workspace: string, row: SecretRow): Promise<string> {
    const plaintext = this.cipher.decrypt({ ciphertext: row.ciphertext, iv: row.iv, tag: row.tag });
    if (row.kind !== "offline_token") return plaintext;
    const env = decodeEnvelope(plaintext);
    return this.offline.resolve(`${workspace} ${row.owner} ${row.name}`, env, async (next) => {
      const enc = this.cipher.encrypt(encodeEnvelope(next));
      await this.client.query(
        "UPDATE everdict_secrets SET ciphertext = $4, iv = $5, tag = $6, access_token_expires_at = $7 WHERE workspace = $1 AND owner = $2 AND name = $3",
        [workspace, row.owner, row.name, enc.ciphertext, enc.iv, enc.tag, next.accessTokenExpiresAt],
      );
    });
  }
  async entries(workspace: string): Promise<Record<string, string>> {
    const r = await this.client.query<SecretRow>(
      "SELECT name, owner, ciphertext, iv, tag, kind FROM everdict_secrets WHERE workspace = $1 AND owner = ''",
      [workspace],
    );
    const out: Record<string, string> = {};
    for (const row of r.rows) {
      try {
        out[row.name] = await this.resolveRow(workspace, row);
      } catch {
        // skip a corrupt/unusable offline_token rather than breaking the whole injection map
      }
    }
    return out;
  }
  async scopedEntries(workspace: string, subject: string): Promise<ScopedSecretEntries> {
    const r = await this.client.query<SecretRow>(
      "SELECT name, owner, ciphertext, iv, tag, kind FROM everdict_secrets WHERE workspace = $1 AND (owner = '' OR owner = $2)",
      [workspace, subject],
    );
    const workspaceEntries: Record<string, string> = {};
    const user: Record<string, string> = {};
    for (const row of r.rows) {
      try {
        const value = await this.resolveRow(workspace, row);
        if (row.owner === "") workspaceEntries[row.name] = value;
        else user[row.name] = value;
      } catch {
        // skip an unusable offline_token (see entries)
      }
    }
    return { workspace: workspaceEntries, user };
  }
}
