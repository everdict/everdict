import { MattermostService } from "@everdict/application-control";
import { InMemoryWorkspaceSettingsStore } from "@everdict/db";
import { beforeEach, describe, expect, it } from "vitest";

describe("MattermostService", () => {
  let settings: InMemoryWorkspaceSettingsStore;
  let svc: MattermostService;
  beforeEach(() => {
    settings = new InMemoryWorkspaceSettingsStore();
    svc = new MattermostService(settings);
  });

  it("get is undefined when unconfigured", async () => {
    expect(await svc.get("acme")).toBeUndefined();
  });

  it("after registration, get returns host/botTokenSecretName/defaultChannelId (no secret values)", async () => {
    await svc.set("acme", { host: "https://mm.corp.io", botTokenSecretName: "MM_BOT", defaultChannelId: "ch" });
    expect(await svc.get("acme")).toEqual({
      host: "https://mm.corp.io",
      botTokenSecretName: "MM_BOT",
      defaultChannelId: "ch",
    });
  });

  it("updating without defaultChannelId preserves the existing channel", async () => {
    await svc.set("acme", { host: "https://mm.corp.io", botTokenSecretName: "MM_BOT", defaultChannelId: "ch" });
    await svc.set("acme", { host: "https://mm2.corp.io", botTokenSecretName: "MM_BOT2" });
    expect(await svc.get("acme")).toEqual({
      host: "https://mm2.corp.io",
      botTokenSecretName: "MM_BOT2",
      defaultChannelId: "ch",
    });
  });

  it("clear voids the config (get → undefined, idempotent)", async () => {
    await svc.set("acme", { host: "https://mm.corp.io", botTokenSecretName: "MM_BOT" });
    await svc.clear("acme");
    expect(await svc.get("acme")).toBeUndefined();
    await svc.clear("acme"); // idempotent
    expect(await svc.get("acme")).toBeUndefined();
  });
});
