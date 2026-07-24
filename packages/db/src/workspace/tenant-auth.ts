import { randomUUID } from "node:crypto";
import { generateAgentToken, generateKey, hashKey } from "@everdict/application-control";
import type { ResolvedKey, TenantKeyMeta } from "@everdict/contracts";
import type { SqlClient } from "../client.js";

// Tenant API key store — never stores the plaintext, keeps only the SHA-256 hash.
// For self-serve management (list/revoke), also keeps non-secret metadata (id/label/prefix/scopes):
//  - id     = stable identifier (to target a revoke; so key_hash is never exposed)
//  - label  = human-assigned name (optional)
//  - prefix = ak_abcd… (a leading-plaintext identification hint — not a hash/plaintext; used to tell keys apart in a list)
//  - scopes = per-key permission scope (read|write|admin). Unset (legacy row/full access) → undefined = unrestricted.
//             The permission matrix (scope→action) is owned by @everdict/auth (this is a dumb string store; avoids a cyclic dependency).

import type { TenantKeyStore } from "@everdict/application-control";

interface KeyRow {
  tenant: string;
  owner: string;
  id: string;
  label?: string;
  prefix: string;
  scopes?: string[];
  createdAt: string;
}

// Scopes ↔ stored string (space-delimited). An empty array/unset is stored as NULL (=unrestricted).
function serializeScopes(scopes?: string[]): string | null {
  return scopes && scopes.length > 0 ? scopes.join(" ") : null;
}
function parseScopes(text: string | null | undefined): string[] | undefined {
  if (!text) return undefined;
  const parts = text.split(" ").filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

export class InMemoryTenantKeyStore implements TenantKeyStore {
  private readonly byHash = new Map<string, KeyRow>(); // keyHash → row
  constructor(private readonly now: () => string = () => new Date().toISOString()) {}
  async add(
    tenant: string,
    keyHash: string,
    meta?: { id?: string; label?: string; prefix?: string; scopes?: string[]; owner?: string },
  ): Promise<void> {
    this.byHash.set(keyHash, {
      tenant,
      owner: meta?.owner ?? "",
      id: meta?.id ?? randomUUID(),
      label: meta?.label,
      prefix: meta?.prefix ?? "",
      scopes: meta?.scopes && meta.scopes.length > 0 ? meta.scopes : undefined,
      createdAt: this.now(),
    });
  }
  async resolveByHash(keyHash: string): Promise<ResolvedKey | undefined> {
    const row = this.byHash.get(keyHash);
    return row ? { tenant: row.tenant, owner: row.owner, scopes: row.scopes } : undefined;
  }
  async list(tenant: string, owner?: string): Promise<TenantKeyMeta[]> {
    return [...this.byHash.values()]
      .filter((r) => r.tenant === tenant && (owner === undefined || r.owner === owner))
      .map((r) => ({ id: r.id, label: r.label, prefix: r.prefix, scopes: r.scopes, createdAt: r.createdAt }))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); // newest first
  }
  async revoke(tenant: string, id: string, owner?: string): Promise<void> {
    for (const [hash, row] of this.byHash)
      if (row.tenant === tenant && row.id === id && (owner === undefined || row.owner === owner))
        this.byHash.delete(hash);
  }
}

export class PgTenantKeyStore implements TenantKeyStore {
  constructor(private readonly client: SqlClient) {}
  async add(
    tenant: string,
    keyHash: string,
    meta?: { id?: string; label?: string; prefix?: string; scopes?: string[]; owner?: string },
  ): Promise<void> {
    await this.client.query(
      `INSERT INTO everdict_tenant_keys (key_hash, tenant, owner, id, label, prefix, scopes, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now()) ON CONFLICT (key_hash) DO NOTHING`,
      [
        keyHash,
        tenant,
        meta?.owner ?? "",
        meta?.id ?? randomUUID(),
        meta?.label ?? null,
        meta?.prefix ?? "",
        serializeScopes(meta?.scopes),
      ],
    );
  }
  async resolveByHash(keyHash: string): Promise<ResolvedKey | undefined> {
    const res = await this.client.query<{ tenant: string; owner: string; scopes: string | null }>(
      "SELECT tenant, owner, scopes FROM everdict_tenant_keys WHERE key_hash = $1",
      [keyHash],
    );
    const row = res.rows[0];
    return row ? { tenant: row.tenant, owner: row.owner, scopes: parseScopes(row.scopes) } : undefined;
  }
  async list(tenant: string, owner?: string): Promise<TenantKeyMeta[]> {
    // Don't select key_hash (never expose it). prefix is COALESCE'd for legacy rows.
    const res = await this.client.query<{
      id: string;
      label: string | null;
      prefix: string;
      scopes: string | null;
      created_at: string;
    }>(
      "SELECT id, label, COALESCE(prefix, '') AS prefix, scopes, created_at FROM everdict_tenant_keys WHERE tenant = $1 AND ($2::text IS NULL OR owner = $2) ORDER BY created_at DESC",
      [tenant, owner ?? null],
    );
    return res.rows.map((x) => ({
      id: x.id,
      label: x.label ?? undefined,
      prefix: x.prefix,
      scopes: parseScopes(x.scopes),
      createdAt: x.created_at,
    }));
  }
  async revoke(tenant: string, id: string, owner?: string): Promise<void> {
    await this.client.query(
      "DELETE FROM everdict_tenant_keys WHERE tenant = $1 AND id = $2 AND ($3::text IS NULL OR owner = $3)",
      [tenant, id, owner ?? null],
    );
  }
}

// Issue a new key for a tenant → store the hash + non-secret meta (id/label/prefix/scopes), return the plaintext (the caller shows it once and discards it).
// If scopes is unset, it's stored as unrestricted (full access) — deciding the scope default (e.g. ["admin"]) is the caller's (API/MCP boundary) responsibility.
// Bearer key → workspace/scopes resolution is done directly by the control-plane auth core (`@everdict/auth`'s apiKeyAuthenticator)
// via `resolveByHash(hashKey(...))`. This only provides the store primitives.
export async function issueKey(
  store: TenantKeyStore,
  tenant: string,
  label?: string,
  scopes?: string[],
  owner?: string, // issuer subject (personal key). Unset="" (workspace machine key, resolved as admin).
): Promise<string> {
  const key = generateKey();
  const prefix = key.slice(0, 12); // "ak_" + first 9 chars — list identification hint (not a hash/plaintext)
  await store.add(tenant, hashKey(key), { id: randomUUID(), label, prefix, scopes, owner });
  return key; // return plaintext
}

// Issue an agent execution token (agt_) into the SAME key store (docs/architecture/agent-execution-auth.md, A2). Owner
// = the creator the token acts AS (required — never a machine token). Default scope "write" (no governance/secrets).
// Stored with the agt_ prefix so the key-list surface can distinguish it from a user's ak_ keys. Plaintext once.
export async function issueAgentToken(
  store: TenantKeyStore,
  tenant: string,
  owner: string,
  scopes: string[] = ["write"],
  label?: string,
): Promise<string> {
  const token = generateAgentToken();
  const prefix = token.slice(0, 12); // "agt_" + first 8 chars — list identification hint
  await store.add(tenant, hashKey(token), { id: randomUUID(), label, prefix, scopes, owner });
  return token;
}

// True for a key row that is an agent execution token (agt_), so the personal key-list surface can hide it — an agt_
// token is not a user-managed API key, it's a teammate/proactive credential tied to that agent's lifecycle.
export function isAgentTokenPrefix(prefix: string): boolean {
  return prefix.startsWith("agt_");
}
