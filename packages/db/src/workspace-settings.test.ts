import { describe, expect, it } from "vitest";
import type { SqlClient } from "./client.js";
import {
  InMemoryWorkspaceSettingsStore,
  PgWorkspaceSettingsStore,
  WorkspaceSettingsSchema,
} from "./workspace-settings.js";

const MM = { host: "https://mm.example.com", botTokenSecretName: "MM_BOT", defaultChannelId: "ch1" };

describe("WorkspaceSettings.mattermost", () => {
  it("round-trips the workspace Mattermost settings (the values aren't secrets — name references only)", async () => {
    const store = new InMemoryWorkspaceSettingsStore();
    await store.set("acme", { mattermost: MM });
    expect((await store.get("acme"))?.mattermost).toEqual(MM);
  });

  it("one settings key doesn't overwrite another key (meterUsage) (partial merge)", async () => {
    const store = new InMemoryWorkspaceSettingsStore();
    await store.set("acme", { meterUsage: true });
    await store.set("acme", { mattermost: MM });
    const got = await store.get("acme");
    expect(got?.meterUsage).toBe(true);
    expect(got?.mattermost?.host).toBe("https://mm.example.com");
  });

  it("the schema rejects a host that isn't a URL", () => {
    const bad = WorkspaceSettingsSchema.safeParse({ mattermost: { ...MM, host: "mm" } });
    expect(bad.success).toBe(false);
  });

  it("PgWorkspaceSettingsStore.set stores via a jsonb || (merge) upsert", async () => {
    const calls: Array<{ text: string; params?: unknown[] }> = [];
    const client: SqlClient = {
      async query(text, params) {
        calls.push({ text, params });
        return { rows: [{ settings: { mattermost: MM } }] } as { rows: never[] };
      },
    };
    const saved = await new PgWorkspaceSettingsStore(client).set("acme", { mattermost: MM });
    expect(calls[0]?.text).toMatch(/settings \|\| \$2::jsonb/);
    expect(saved.mattermost?.host).toBe("https://mm.example.com");
  });
});
