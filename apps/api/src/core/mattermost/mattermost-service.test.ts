import type {
  MattermostChannel,
  MattermostClient,
  MattermostPostView,
  MattermostProbeResult,
} from "@everdict/application-control";
import { MattermostService } from "@everdict/application-control";
import { BadRequestError } from "@everdict/contracts";
import { InMemoryWorkspaceSettingsStore } from "@everdict/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const HOST = "https://mm.corp.io";

// A fake Mattermost client — verify returns whatever the test queues; post/listChannels/getChannelPosts record their
// calls for assertions and return the queued reads.
function fakeClient(
  verify: () => Promise<MattermostProbeResult>,
  reads?: { channels?: MattermostChannel[]; posts?: MattermostPostView[] },
): MattermostClient {
  return {
    post: vi.fn(async () => {}),
    verify: vi.fn(verify),
    listChannels: vi.fn(async () => reads?.channels ?? []),
    getChannelPosts: vi.fn(async () => reads?.posts ?? []),
  };
}

describe("MattermostService", () => {
  let settings: InMemoryWorkspaceSettingsStore;

  // Build a service with the operator host (config.host) + a canned verify result + a secret map for the bot token.
  // noHost simulates MATTERMOST_HOST being unset (distinct from the default host).
  function build(opts?: {
    host?: string;
    noHost?: boolean;
    verify?: () => Promise<MattermostProbeResult>;
    secrets?: Record<string, string>;
    reads?: { channels?: MattermostChannel[]; posts?: MattermostPostView[] };
  }): { svc: MattermostService; client: MattermostClient } {
    const client = fakeClient(
      opts?.verify ?? (async () => ({ reachable: true, detail: "ok", botUsername: "bot" })),
      opts?.reads,
    );
    const host = opts?.noHost ? undefined : (opts?.host ?? HOST);
    const svc = new MattermostService({
      settings,
      client,
      secretsFor: async () => opts?.secrets ?? { MM_BOT: "xoxb-token", MM_BOT2: "xoxb-token-2" },
      config: { ...(host ? { host } : {}), apiPublicUrl: "http://api.test" },
    });
    return { svc, client };
  }

  beforeEach(() => {
    settings = new InMemoryWorkspaceSettingsStore();
  });

  it("get exposes the operator server URL (env) and no config when unregistered", async () => {
    const { svc } = build();
    expect(await svc.get("acme")).toEqual({ host: HOST });
  });

  it("after a verified registration, get returns host (operator env) + config without any secret values", async () => {
    const { svc } = build();
    await svc.set("acme", { botTokenSecretName: "MM_BOT", defaultChannelId: "ch" });
    expect(await svc.get("acme")).toEqual({
      host: HOST,
      config: { botTokenSecretName: "MM_BOT", defaultChannelId: "ch" },
    });
  });

  it("set verifies the bot token (+ channel) against the live server before saving", async () => {
    const { svc, client } = build();
    await svc.set("acme", { botTokenSecretName: "MM_BOT", defaultChannelId: "ch" });
    expect(client.verify).toHaveBeenCalledWith(HOST, "xoxb-token", "ch");
  });

  it("set is strict — a failed connection blocks the save with the classified reason (nothing persisted)", async () => {
    const { svc } = build({
      verify: async () => ({ reachable: false, reason: "channel", detail: "Channel not accessible (404)." }),
    });
    await expect(svc.set("acme", { botTokenSecretName: "MM_BOT", defaultChannelId: "bad" })).rejects.toBeInstanceOf(
      BadRequestError,
    );
    expect(await svc.get("acme")).toEqual({ host: HOST }); // unchanged — no config written
  });

  it("set fails when the operator has not configured a server URL (MATTERMOST_HOST unset)", async () => {
    const { svc } = build({ noHost: true });
    await expect(svc.set("acme", { botTokenSecretName: "MM_BOT" })).rejects.toBeInstanceOf(BadRequestError);
    expect(await svc.get("acme")).toEqual({}); // no host, no config
  });

  it("set fails when the bot token secret is missing from the SecretStore", async () => {
    const { svc } = build({ secrets: {} });
    await expect(svc.set("acme", { botTokenSecretName: "MM_BOT" })).rejects.toBeInstanceOf(BadRequestError);
  });

  it("updating without defaultChannelId preserves the existing channel (and re-verifies)", async () => {
    const { svc } = build();
    await svc.set("acme", { botTokenSecretName: "MM_BOT", defaultChannelId: "ch" });
    await svc.set("acme", { botTokenSecretName: "MM_BOT2" });
    expect((await svc.get("acme")).config).toEqual({ botTokenSecretName: "MM_BOT2", defaultChannelId: "ch" });
  });

  it("probe returns the classified connection-test outcome without persisting anything", async () => {
    const { svc } = build({
      verify: async () => ({ reachable: true, detail: "ok", botUsername: "bot", channelName: "General" }),
    });
    const result = await svc.probe("acme", { botTokenSecretName: "MM_BOT", defaultChannelId: "ch" });
    expect(result).toEqual({ reachable: true, detail: "ok", botUsername: "bot", channelName: "General" });
    expect((await svc.get("acme")).config).toBeUndefined(); // probe never writes
  });

  it("clear voids the config (get → host only, idempotent)", async () => {
    const { svc } = build();
    await svc.set("acme", { botTokenSecretName: "MM_BOT" });
    await svc.clear("acme");
    expect(await svc.get("acme")).toEqual({ host: HOST });
    await svc.clear("acme"); // idempotent
    expect(await svc.get("acme")).toEqual({ host: HOST });
  });

  describe("postMessage (agent post_mattermost_message)", () => {
    it("posts to the configured default channel via the resolved bot token, returning the channel", async () => {
      const { svc, client } = build();
      await svc.set("acme", { botTokenSecretName: "MM_BOT", defaultChannelId: "ch" });
      const out = await svc.postMessage("acme", "regression on suite X");
      expect(out).toEqual({ channelId: "ch" });
      expect(client.post).toHaveBeenCalledWith(HOST, "xoxb-token", {
        channelId: "ch",
        message: "regression on suite X",
      });
    });

    it("throws when the workspace has not registered Mattermost", async () => {
      const { svc, client } = build();
      await expect(svc.postMessage("acme", "hi")).rejects.toBeInstanceOf(BadRequestError);
      expect(client.post).not.toHaveBeenCalled();
    });

    it("throws when the registration has no default channel", async () => {
      const { svc, client } = build();
      await svc.set("acme", { botTokenSecretName: "MM_BOT" }); // registered, but no channel
      await expect(svc.postMessage("acme", "hi")).rejects.toBeInstanceOf(BadRequestError);
      expect(client.post).not.toHaveBeenCalled();
    });

    it("throws when the operator server URL is unset (MATTERMOST_HOST)", async () => {
      const { svc } = build({ noHost: true });
      await expect(svc.postMessage("acme", "hi")).rejects.toBeInstanceOf(BadRequestError);
    });
  });

  describe("read tools (agent list_mattermost_channels / get_mattermost_channel_posts)", () => {
    const channels: MattermostChannel[] = [
      { id: "c1", name: "town-square", displayName: "Town Square", teamId: "t1", type: "O" },
    ];
    const posts: MattermostPostView[] = [{ id: "p1", userId: "u1", message: "hi", createdAt: 1 }];

    it("lists channels via the resolved bot token", async () => {
      const { svc, client } = build({ reads: { channels } });
      await svc.set("acme", { botTokenSecretName: "MM_BOT" });
      expect(await svc.listChannels("acme")).toEqual({ channels });
      expect(client.listChannels).toHaveBeenCalledWith(HOST, "xoxb-token");
    });

    it("reads channel posts with the limit clamped to 1..100 (default 30)", async () => {
      const { svc, client } = build({ reads: { posts } });
      await svc.set("acme", { botTokenSecretName: "MM_BOT" });
      expect(await svc.getChannelPosts("acme", "c1")).toEqual({ posts });
      expect(client.getChannelPosts).toHaveBeenCalledWith(HOST, "xoxb-token", "c1", 30); // default
      await svc.getChannelPosts("acme", "c1", 500); // over max → clamped
      expect(client.getChannelPosts).toHaveBeenLastCalledWith(HOST, "xoxb-token", "c1", 100);
    });

    it("throws when the workspace has not registered Mattermost", async () => {
      const { svc, client } = build();
      await expect(svc.listChannels("acme")).rejects.toBeInstanceOf(BadRequestError);
      await expect(svc.getChannelPosts("acme", "c1")).rejects.toBeInstanceOf(BadRequestError);
      expect(client.listChannels).not.toHaveBeenCalled();
      expect(client.getChannelPosts).not.toHaveBeenCalled();
    });

    it("throws when the operator server URL is unset (MATTERMOST_HOST)", async () => {
      const { svc } = build({ noHost: true });
      await expect(svc.listChannels("acme")).rejects.toBeInstanceOf(BadRequestError);
    });
  });
});
