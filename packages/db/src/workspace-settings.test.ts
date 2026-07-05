import { describe, expect, it } from "vitest";
import type { SqlClient } from "./client.js";
import {
  InMemoryWorkspaceSettingsStore,
  PgWorkspaceSettingsStore,
  WorkspaceSettingsSchema,
} from "./workspace-settings.js";

const MM = { host: "https://mm.example.com", botTokenSecretName: "MM_BOT", defaultChannelId: "ch1" };

describe("WorkspaceSettings.mattermost", () => {
  it("워크스페이스 Mattermost 설정을 라운드트립한다(값은 비밀 아님 — 이름 참조만)", async () => {
    const store = new InMemoryWorkspaceSettingsStore();
    await store.set("acme", { mattermost: MM });
    expect((await store.get("acme"))?.mattermost).toEqual(MM);
  });

  it("한 설정 키가 다른 키(meterUsage)를 덮어쓰지 않는다(부분 병합)", async () => {
    const store = new InMemoryWorkspaceSettingsStore();
    await store.set("acme", { meterUsage: true });
    await store.set("acme", { mattermost: MM });
    const got = await store.get("acme");
    expect(got?.meterUsage).toBe(true);
    expect(got?.mattermost?.host).toBe("https://mm.example.com");
  });

  it("schema 는 host 가 URL 이 아니면 거부한다", () => {
    const bad = WorkspaceSettingsSchema.safeParse({ mattermost: { ...MM, host: "mm" } });
    expect(bad.success).toBe(false);
  });

  it("PgWorkspaceSettingsStore.set 은 jsonb ||(병합) upsert 로 저장한다", async () => {
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
