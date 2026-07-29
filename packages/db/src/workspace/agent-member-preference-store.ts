import type { AgentMemberPreferenceStore } from "@everdict/application-control";
import {
  type AgentMemberPreferences,
  AgentMemberPreferencesSchema,
  type AgentPreferenceChannel,
} from "@everdict/contracts";

import type { SqlClient } from "../client.js";

// The per-MEMBER agent overlay (mig 0090) — two channels, tools and skills. Self-scoped by (tenant, subject): the
// workspace AgentSpec + skill library are the shared baseline, this is one member's on/off on top of them. Setting an
// entry to `null` DELETES the key rather than storing the baseline's current value — that is what keeps the member
// following the workspace afterwards.

const emptyPreferences = (tenant: string, subject: string, updatedAt: string): AgentMemberPreferences => ({
  tenant,
  subject,
  tools: {},
  skills: {},
  updatedAt,
});

// `enabled: null` removes the key (back to the workspace baseline); a boolean sets it.
function applyEntry(decisions: Record<string, boolean>, key: string, enabled: boolean | null): Record<string, boolean> {
  const next = { ...decisions };
  if (enabled === null) delete next[key];
  else next[key] = enabled;
  return next;
}

export class InMemoryAgentMemberPreferenceStore implements AgentMemberPreferenceStore {
  private readonly byMember = new Map<string, AgentMemberPreferences>();

  private key(tenant: string, subject: string): string {
    return `${tenant} ${subject}`;
  }

  private clone(p: AgentMemberPreferences): AgentMemberPreferences {
    return { ...p, tools: { ...p.tools }, skills: { ...p.skills } };
  }

  async get(tenant: string, subject: string): Promise<AgentMemberPreferences | undefined> {
    const current = this.byMember.get(this.key(tenant, subject));
    return current ? this.clone(current) : undefined;
  }

  async setEntry(
    tenant: string,
    subject: string,
    channel: AgentPreferenceChannel,
    key: string,
    enabled: boolean | null,
  ): Promise<AgentMemberPreferences> {
    const now = new Date().toISOString();
    const current = this.byMember.get(this.key(tenant, subject)) ?? emptyPreferences(tenant, subject, now);
    const next: AgentMemberPreferences = {
      ...current,
      [channel]: applyEntry(current[channel], key, enabled),
      updatedAt: now,
    };
    this.byMember.set(this.key(tenant, subject), next);
    return this.clone(next);
  }
}

interface PreferencesRow {
  tenant: string;
  subject: string;
  tools: unknown;
  skills: unknown;
  updated_at: string | Date;
}

const iso = (v: string | Date): string => (typeof v === "string" ? v : v.toISOString());

const rowToRecord = (row: PreferencesRow): AgentMemberPreferences =>
  AgentMemberPreferencesSchema.parse({
    tenant: row.tenant,
    subject: row.subject,
    tools: row.tools,
    skills: row.skills,
    updatedAt: iso(row.updated_at),
  });

const COLUMNS = "tenant, subject, tools, skills, updated_at";

export class PgAgentMemberPreferenceStore implements AgentMemberPreferenceStore {
  constructor(private readonly client: SqlClient) {}

  async get(tenant: string, subject: string): Promise<AgentMemberPreferences | undefined> {
    const r = await this.client.query<PreferencesRow>(
      `SELECT ${COLUMNS} FROM everdict_agent_member_preferences WHERE tenant = $1 AND subject = $2`,
      [tenant, subject],
    );
    const row = r.rows[0];
    return row ? rowToRecord(row) : undefined;
  }

  async setEntry(
    tenant: string,
    subject: string,
    channel: AgentPreferenceChannel,
    key: string,
    enabled: boolean | null,
  ): Promise<AgentMemberPreferences> {
    // One atomic statement per toggle: jsonb_set for a decision, the `-` operator to drop it. Two tabs toggling
    // different entries therefore never clobber each other's key (a read-modify-write of the whole doc would).
    // The channel picks the COLUMN (never a parameter — it is a closed vocabulary from the contract).
    const column = channel === "skills" ? "skills" : "tools";
    const sql =
      enabled === null
        ? `INSERT INTO everdict_agent_member_preferences (tenant, subject, ${column}, updated_at)
           VALUES ($1, $2, '{}'::jsonb, now())
           ON CONFLICT (tenant, subject) DO UPDATE
             SET ${column} = everdict_agent_member_preferences.${column} - $3::text, updated_at = now()
           RETURNING ${COLUMNS}`
        : `INSERT INTO everdict_agent_member_preferences (tenant, subject, ${column}, updated_at)
           VALUES ($1, $2, jsonb_build_object($3::text, $4::boolean), now())
           ON CONFLICT (tenant, subject) DO UPDATE
             SET ${column} = jsonb_set(everdict_agent_member_preferences.${column}, ARRAY[$3::text], to_jsonb($4::boolean), true),
                 updated_at = now()
           RETURNING ${COLUMNS}`;
    const params = enabled === null ? [tenant, subject, key] : [tenant, subject, key, enabled];
    const r = await this.client.query<PreferencesRow>(sql, params);
    const row = r.rows[0];
    if (!row) return emptyPreferences(tenant, subject, new Date().toISOString());
    return rowToRecord(row);
  }
}
