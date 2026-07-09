import type { SqlClient } from "../client.js";
import type { EncryptedSecret, SecretCipher } from "./secret-cipher.js";

// Workspace secret store — manages model/provider keys (OPENAI_API_KEY etc.) per scope.
// scope: "workspace" (owner='') = shared (admin-managed) · "user" (owner=subject) = that user's personal (self-managed, invisible to others).
// Values are AES-GCM encrypted at rest and never returned as plaintext (list has only name+scope). Only entries/scopedEntries decrypt (injection-only).
export type SecretScope = "user" | "workspace";

export interface SecretMeta {
  name: string;
  updatedAt: string;
  scope: SecretScope;
}

// The two tiers for dispatch resolution — shared + the submitter's personal. resolveHarnessSecrets picks by the referenced scope.
export interface ScopedSecretEntries {
  workspace: Record<string, string>;
  user: Record<string, string>;
}

export interface SecretStore {
  // owner="" = workspace (shared) secret, owner=subject = user personal secret.
  set(workspace: string, name: string, value: string, owner?: string): Promise<void>;
  // With subject, also returns that user's personal secrets (scope-tagged). Unset returns shared secrets only.
  list(workspace: string, subject?: string): Promise<SecretMeta[]>;
  remove(workspace: string, name: string, owner?: string): Promise<void>;
  entries(workspace: string): Promise<Record<string, string>>; // shared (owner='') secrets only — existing-consumer compat
  scopedEntries(workspace: string, subject: string): Promise<ScopedSecretEntries>; // shared + that user's personal
}

interface MemRow {
  enc: EncryptedSecret;
  updatedAt: string;
  workspace: string;
  owner: string;
  name: string;
}

export class InMemorySecretStore implements SecretStore {
  private readonly rows = new Map<string, MemRow>();
  constructor(
    private readonly cipher: SecretCipher,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}
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
    });
  }
  async list(workspace: string, subject?: string): Promise<SecretMeta[]> {
    const metas: SecretMeta[] = [];
    for (const r of this.rows.values()) {
      if (r.workspace !== workspace) continue;
      if (r.owner === "") metas.push({ name: r.name, updatedAt: r.updatedAt, scope: "workspace" });
      else if (subject && r.owner === subject) metas.push({ name: r.name, updatedAt: r.updatedAt, scope: "user" });
    }
    // Shared first, then personal — name-sorted within each scope.
    return metas.sort((a, b) =>
      a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope === "workspace" ? -1 : 1,
    );
  }
  async remove(workspace: string, name: string, owner = ""): Promise<void> {
    this.rows.delete(this.key(workspace, owner, name));
  }
  async entries(workspace: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const r of this.rows.values())
      if (r.workspace === workspace && r.owner === "") out[r.name] = this.cipher.decrypt(r.enc);
    return out;
  }
  async scopedEntries(workspace: string, subject: string): Promise<ScopedSecretEntries> {
    const workspaceEntries: Record<string, string> = {};
    const user: Record<string, string> = {};
    for (const r of this.rows.values()) {
      if (r.workspace !== workspace) continue;
      if (r.owner === "") workspaceEntries[r.name] = this.cipher.decrypt(r.enc);
      else if (r.owner === subject) user[r.name] = this.cipher.decrypt(r.enc);
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
  updated_at: string;
}

export class PgSecretStore implements SecretStore {
  constructor(
    private readonly client: SqlClient,
    private readonly cipher: SecretCipher,
  ) {}
  async set(workspace: string, name: string, value: string, owner = ""): Promise<void> {
    const { ciphertext, iv, tag } = this.cipher.encrypt(value);
    await this.client.query(
      `INSERT INTO everdict_secrets (workspace, owner, name, ciphertext, iv, tag, updated_at) VALUES ($1,$2,$3,$4,$5,$6, now())
       ON CONFLICT (workspace, owner, name) DO UPDATE SET ciphertext = $4, iv = $5, tag = $6, updated_at = now()`,
      [workspace, owner, name, ciphertext, iv, tag],
    );
  }
  async list(workspace: string, subject?: string): Promise<SecretMeta[]> {
    // owner='' (shared) + owner=subject (personal). No subject → shared only ($2='').
    const r = await this.client.query<{ name: string; owner: string; updated_at: string }>(
      "SELECT name, owner, updated_at FROM everdict_secrets WHERE workspace = $1 AND (owner = '' OR owner = $2) ORDER BY owner, name",
      [workspace, subject ?? ""],
    );
    return r.rows.map((x) => ({
      name: x.name,
      updatedAt: x.updated_at,
      scope: x.owner === "" ? "workspace" : "user",
    }));
  }
  async remove(workspace: string, name: string, owner = ""): Promise<void> {
    await this.client.query("DELETE FROM everdict_secrets WHERE workspace = $1 AND owner = $2 AND name = $3", [
      workspace,
      owner,
      name,
    ]);
  }
  async entries(workspace: string): Promise<Record<string, string>> {
    const r = await this.client.query<SecretRow>(
      "SELECT name, ciphertext, iv, tag FROM everdict_secrets WHERE workspace = $1 AND owner = ''",
      [workspace],
    );
    const out: Record<string, string> = {};
    for (const row of r.rows)
      out[row.name] = this.cipher.decrypt({ ciphertext: row.ciphertext, iv: row.iv, tag: row.tag });
    return out;
  }
  async scopedEntries(workspace: string, subject: string): Promise<ScopedSecretEntries> {
    const r = await this.client.query<SecretRow>(
      "SELECT name, owner, ciphertext, iv, tag FROM everdict_secrets WHERE workspace = $1 AND (owner = '' OR owner = $2)",
      [workspace, subject],
    );
    const workspaceEntries: Record<string, string> = {};
    const user: Record<string, string> = {};
    for (const row of r.rows) {
      const value = this.cipher.decrypt({ ciphertext: row.ciphertext, iv: row.iv, tag: row.tag });
      if (row.owner === "") workspaceEntries[row.name] = value;
      else user[row.name] = value;
    }
    return { workspace: workspaceEntries, user };
  }
}
