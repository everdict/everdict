import { randomBytes, randomUUID } from "node:crypto";
import type { SqlClient } from "../client.js";
import { hashKey } from "./tenant-auth.js";

// Self-hosted runner store — a personal device where a user paired their own machine with a workspace.
// Same model as Connected accounts (ConnectionStore): personally owned (owner=principal.subject) + workspace-visible
// (records the paired workspace → roster). A runner runs the workspace's shared harness/dataset on its own machine "by only swapping the runtime"
// and returns the result (design: docs/architecture/self-hosted-runner.md). Dispatch/lease are a later slice.
// No plaintext storage for the pairing token — only the SHA-256 hash is kept (same as a tenant API key) and the plaintext is shown once at pairing.
export interface RunnerMeta {
  id: string;
  label: string; // display device name (e.g. "ho-macbook")
  os?: string; // linux | darwin | win32 etc. (optional)
  capabilities: string[]; // repo | browser | os-use | docker — the environments this machine can run
  pairedAt: string;
  lastSeenAt?: string; // last lease/heartbeat time (refreshed via touch in a later slice)
}

// Pairing input — the plaintext token is hashed just before storage. The token is issued by the server (the client doesn't choose it).
export interface PairRunnerInput {
  owner: string; // runner owner = principal.subject (OIDC sub / api-key's key:<ws> / dev fallback "dev")
  workspace: string; // paired workspace — for the roster (listByWorkspace). Ownership is owner.
  label: string;
  os?: string;
  capabilities?: string[];
}

// Pairing result — token is plaintext (returned once, stored as a hash). The everdict runner authenticates to MCP with this token (later slice).
export interface PairedRunner {
  meta: RunnerMeta;
  token: string;
}

// Token → runner identification (used in the later slice's MCP auth/lease). Resolves to owner/workspace/runnerId.
export interface ResolvedRunner {
  owner: string;
  workspace: string;
  runnerId: string;
}

export interface RunnerStore {
  pair(input: PairRunnerInput): Promise<PairedRunner>;
  list(owner: string): Promise<RunnerMeta[]>; // personal (owner) meta only
  get(owner: string, id: string): Promise<RunnerMeta | null>; // owner-scoped single record (ownership check — dispatch self: routing)
  listByWorkspace(workspace: string): Promise<RunnerMeta[]>; // workspace roster (meta only)
  remove(owner: string, id: string): Promise<void>; // owner-scoped, idempotent
  touch(owner: string, id: string): Promise<void>; // refresh lastSeenAt (idempotent; no-op for a missing runner)
  setCapabilities(owner: string, id: string, capabilities: string[]): Promise<void>; // runner self-advertise (docker etc.). Idempotent; no-op for a missing runner
  resolveByToken(token: string): Promise<ResolvedRunner | null>; // resolve a runner by token hash (internal only)
}

// rnr_<random> — plaintext pairing token. Shown once at issuance and stored only as a hash.
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
      .sort((a, b) => (a.pairedAt < b.pairedAt ? 1 : -1)); // newest first
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
    capabilities: r.capabilities.split(/\s+/).filter(Boolean), // space-delimited
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
    if (!r) throw new Error("runner insert did not return a row.");
    return { meta: metaOf(input, id, new Date(r.paired_at).toISOString()), token };
  }
  async list(owner: string): Promise<RunnerMeta[]> {
    // Never select token_hash.
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
