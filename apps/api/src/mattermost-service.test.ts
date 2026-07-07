import { InMemoryWorkspaceSettingsStore } from "@everdict/db";
import { beforeEach, describe, expect, it } from "vitest";
import { MattermostService } from "./mattermost-service.js";

describe("MattermostService", () => {
  let settings: InMemoryWorkspaceSettingsStore;
  let svc: MattermostService;
  beforeEach(() => {
    settings = new InMemoryWorkspaceSettingsStore();
    svc = new MattermostService(settings);
  });

  it("미설정이면 get 은 undefined", async () => {
    expect(await svc.get("acme")).toBeUndefined();
  });

  it("등록 후 get 은 host/botTokenSecretName/defaultChannelId 를 돌려준다(비밀 값 없음)", async () => {
    await svc.set("acme", { host: "https://mm.corp.io", botTokenSecretName: "MM_BOT", defaultChannelId: "ch" });
    expect(await svc.get("acme")).toEqual({
      host: "https://mm.corp.io",
      botTokenSecretName: "MM_BOT",
      defaultChannelId: "ch",
    });
  });

  it("defaultChannelId 없이 갱신하면 기존 채널을 보존한다", async () => {
    await svc.set("acme", { host: "https://mm.corp.io", botTokenSecretName: "MM_BOT", defaultChannelId: "ch" });
    await svc.set("acme", { host: "https://mm2.corp.io", botTokenSecretName: "MM_BOT2" });
    expect(await svc.get("acme")).toEqual({
      host: "https://mm2.corp.io",
      botTokenSecretName: "MM_BOT2",
      defaultChannelId: "ch",
    });
  });

  it("clear 는 설정을 무효화한다(get → undefined, 멱등)", async () => {
    await svc.set("acme", { host: "https://mm.corp.io", botTokenSecretName: "MM_BOT" });
    await svc.clear("acme");
    expect(await svc.get("acme")).toBeUndefined();
    await svc.clear("acme"); // 멱등
    expect(await svc.get("acme")).toBeUndefined();
  });
});
