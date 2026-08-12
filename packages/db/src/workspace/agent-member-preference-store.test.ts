import { describe, expect, it } from "vitest";
import type { SqlClient } from "../client.js";
import { InMemoryAgentMemberPreferenceStore, PgAgentMemberPreferenceStore } from "./agent-member-preference-store.js";

// Captures the SQL a Pg store issues and replays canned rows — the house pattern for Pg logic (no live DB).
function fakeClient(rows: unknown[] = []): SqlClient & { calls: Array<{ text: string; params?: unknown[] }> } {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  return {
    calls,
    async query<R>(text: string, params?: unknown[]): Promise<{ rows: R[] }> {
      calls.push({ text, params });
      return { rows: rows as R[] };
    },
  };
}

describe("InMemoryAgentMemberPreferenceStore", () => {
  it("a member who configured nothing has no row (so they follow the workspace baseline)", async () => {
    const store = new InMemoryAgentMemberPreferenceStore();
    expect(await store.get("acme", "alice")).toBeUndefined();
  });

  it("records one decision per entry without disturbing the others", async () => {
    const store = new InMemoryAgentMemberPreferenceStore();
    await store.setEntry("acme", "alice", "tools", "default:web-search", false);
    const after = await store.setEntry("acme", "alice", "tools", "capability:acme/jira", true);
    expect(after.tools).toEqual({ "default:web-search": false, "capability:acme/jira": true });
  });

  it("keeps the tool and skill channels independent", async () => {
    const store = new InMemoryAgentMemberPreferenceStore();
    await store.setEntry("acme", "alice", "tools", "default:web-search", false);
    const after = await store.setEntry("acme", "alice", "skills", "skill:triage", false);
    expect(after.tools).toEqual({ "default:web-search": false });
    expect(after.skills).toEqual({ "skill:triage": false });
  });

  it("null REMOVES the override rather than freezing today's baseline value", async () => {
    const store = new InMemoryAgentMemberPreferenceStore();
    await store.setEntry("acme", "alice", "skills", "skill:triage", false);
    const after = await store.setEntry("acme", "alice", "skills", "skill:triage", null);
    expect(after.skills).toEqual({});
    expect("skill:triage" in after.skills).toBe(false);
  });

  it("a member's default model starts unset (null = follow the workspace baseline)", async () => {
    const store = new InMemoryAgentMemberPreferenceStore();
    const after = await store.setEntry("acme", "alice", "tools", "default:web-search", false);
    expect(after.model).toBeNull();
  });

  it("records the member's own default model without disturbing their tools or skills", async () => {
    const store = new InMemoryAgentMemberPreferenceStore();
    await store.setEntry("acme", "alice", "tools", "default:web-search", false);
    const after = await store.setModel("acme", "alice", "opus");
    expect(after.model).toBe("opus");
    expect(after.tools).toEqual({ "default:web-search": false });
  });

  it("null clears the model pick so the workspace baseline reaches the member again", async () => {
    const store = new InMemoryAgentMemberPreferenceStore();
    await store.setModel("acme", "alice", "opus");
    expect((await store.setModel("acme", "alice", null)).model).toBeNull();
  });

  it("keeps two members' default models independent", async () => {
    const store = new InMemoryAgentMemberPreferenceStore();
    await store.setModel("acme", "alice", "opus");
    await store.setModel("acme", "bob", "haiku");
    expect((await store.get("acme", "alice"))?.model).toBe("opus");
    expect((await store.get("acme", "bob"))?.model).toBe("haiku");
  });

  it("keeps two members of the same workspace independent", async () => {
    const store = new InMemoryAgentMemberPreferenceStore();
    await store.setEntry("acme", "alice", "tools", "capability:acme/jira", false);
    await store.setEntry("acme", "bob", "tools", "capability:acme/jira", true);
    expect((await store.get("acme", "alice"))?.tools).toEqual({ "capability:acme/jira": false });
    expect((await store.get("acme", "bob"))?.tools).toEqual({ "capability:acme/jira": true });
  });

  it("scopes a subject's preferences per workspace", async () => {
    const store = new InMemoryAgentMemberPreferenceStore();
    await store.setEntry("acme", "alice", "tools", "default:web-search", false);
    expect(await store.get("other", "alice")).toBeUndefined();
  });

  it("does not hand out its internal maps (a mutated result cannot corrupt the store)", async () => {
    const store = new InMemoryAgentMemberPreferenceStore();
    const saved = await store.setEntry("acme", "alice", "tools", "default:web-search", false);
    saved.tools["default:web-search"] = true;
    expect((await store.get("acme", "alice"))?.tools).toEqual({ "default:web-search": false });
  });
});

describe("PgAgentMemberPreferenceStore", () => {
  const row = {
    tenant: "acme",
    subject: "alice",
    tools: { "default:web-search": false },
    skills: {},
    model: null,
    updated_at: new Date(0),
  };

  it("upserts a single key with jsonb_set so a concurrent toggle of another entry survives", async () => {
    const client = fakeClient([row]);
    await new PgAgentMemberPreferenceStore(client).setEntry("acme", "alice", "tools", "default:web-search", false);
    expect(client.calls[0]?.text).toContain("jsonb_set");
    expect(client.calls[0]?.params).toEqual(["acme", "alice", "default:web-search", false]);
  });

  it("writes the skills channel into its own column", async () => {
    const client = fakeClient([{ ...row, skills: { "skill:triage": false } }]);
    await new PgAgentMemberPreferenceStore(client).setEntry("acme", "alice", "skills", "skill:triage", false);
    expect(client.calls[0]?.text).toContain("SET skills = jsonb_set(everdict_agent_member_preferences.skills");
    expect(client.calls[0]?.text).not.toContain("SET tools =");
  });

  it("drops the key (jsonb `-`) when the member goes back to the workspace default", async () => {
    const client = fakeClient([{ ...row, tools: {} }]);
    const after = await new PgAgentMemberPreferenceStore(client).setEntry(
      "acme",
      "alice",
      "tools",
      "default:web-search",
      null,
    );
    expect(client.calls[0]?.text).toContain("- $3::text");
    expect(after.tools).toEqual({});
  });

  it("scopes the read by (tenant, subject) and parses both channels", async () => {
    const client = fakeClient([{ ...row, skills: { "skill:triage": true } }]);
    const got = await new PgAgentMemberPreferenceStore(client).get("acme", "alice");
    expect(client.calls[0]?.params).toEqual(["acme", "alice"]);
    expect(got?.tools).toEqual({ "default:web-search": false });
    expect(got?.skills).toEqual({ "skill:triage": true });
    expect(got?.updatedAt).toBe(new Date(0).toISOString());
  });

  it("writes the model into its own column so a concurrent tool toggle survives", async () => {
    const client = fakeClient([{ ...row, model: "opus" }]);
    const after = await new PgAgentMemberPreferenceStore(client).setModel("acme", "alice", "opus");
    expect(client.calls[0]?.text).toContain("SET model = $3::text");
    expect(client.calls[0]?.text).not.toContain("jsonb_set");
    expect(client.calls[0]?.params).toEqual(["acme", "alice", "opus"]);
    expect(after.model).toBe("opus");
  });

  it("writes NULL (not a deleted column) when the member goes back to the workspace default", async () => {
    const client = fakeClient([{ ...row, model: null }]);
    const after = await new PgAgentMemberPreferenceStore(client).setModel("acme", "alice", null);
    expect(client.calls[0]?.params).toEqual(["acme", "alice", null]);
    expect(after.model).toBeNull();
  });

  it("a member with no row is undefined", async () => {
    expect(await new PgAgentMemberPreferenceStore(fakeClient([])).get("acme", "ghost")).toBeUndefined();
  });
});
