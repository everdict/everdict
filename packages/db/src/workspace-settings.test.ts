import { describe, expect, it } from "vitest";
import type { SqlClient } from "./client.js";
import {
  InMemoryWorkspaceSettingsStore,
  PgWorkspaceSettingsStore,
  WorkspaceSettingsSchema,
} from "./workspace-settings.js";

const GHE = { host: "https://ghe.example.com", clientId: "Iv1.abc", clientSecretName: "GHE_OAUTH_SECRET" };

describe("WorkspaceSettings.integrations", () => {
  it("self-hosted 통합 자격증명을 라운드트립한다(값은 비밀 아님)", async () => {
    const store = new InMemoryWorkspaceSettingsStore();
    await store.set("acme", { integrations: { "github-enterprise": GHE } });
    const got = await store.get("acme");
    expect(got?.integrations?.["github-enterprise"]).toEqual(GHE);
  });

  it("integrations 설정이 다른 설정 키(notify/meterUsage)를 덮어쓰지 않는다", async () => {
    const store = new InMemoryWorkspaceSettingsStore();
    await store.set("acme", { meterUsage: true, notify: { connectionId: "c1", channelId: "ch1" } });
    await store.set("acme", { integrations: { mattermost: { ...GHE, host: "https://mm.example.com" } } });
    const got = await store.get("acme");
    expect(got?.meterUsage).toBe(true);
    expect(got?.notify?.connectionId).toBe("c1");
    expect(got?.integrations?.mattermost?.host).toBe("https://mm.example.com");
  });

  it("schema 는 host 가 URL 이 아니면 거부한다", () => {
    const bad = WorkspaceSettingsSchema.safeParse({ integrations: { "github-enterprise": { ...GHE, host: "ghe" } } });
    expect(bad.success).toBe(false);
  });

  it("PgWorkspaceSettingsStore.set 은 jsonb ||(병합) upsert 로 통합을 저장한다", async () => {
    const calls: Array<{ text: string; params?: unknown[] }> = [];
    const client: SqlClient = {
      async query(text, params) {
        calls.push({ text, params });
        return { rows: [{ settings: { integrations: { "github-enterprise": GHE } } }] } as { rows: never[] };
      },
    };
    const saved = await new PgWorkspaceSettingsStore(client).set("acme", {
      integrations: { "github-enterprise": GHE },
    });
    expect(calls[0]?.text).toMatch(/settings \|\| \$2::jsonb/);
    expect(saved.integrations?.["github-enterprise"]).toEqual(GHE);
  });
});
