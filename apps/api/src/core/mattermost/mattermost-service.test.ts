import type {
  MattermostChannel,
  MattermostClient,
  MattermostPostView,
  MattermostProbeResult,
} from "@everdict/application-control";
import { MattermostService } from "@everdict/application-control";
import { BadRequestError, NotFoundError } from "@everdict/contracts";
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

  it("get exposes the operator server URL (env) and no connections when unregistered", async () => {
    const { svc } = build();
    expect(await svc.get("acme")).toEqual({ host: HOST, connections: [] });
  });

  it("after a verified registration, get returns host (operator env) + the connection without any secret values", async () => {
    const { svc } = build();
    await svc.set("acme", { botTokenSecretName: "MM_BOT", defaultChannelId: "ch" });
    expect(await svc.get("acme")).toEqual({
      host: HOST,
      connections: [{ name: "default", botTokenSecretName: "MM_BOT", defaultChannelId: "ch" }],
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
    expect(await svc.get("acme")).toEqual({ host: HOST, connections: [] }); // unchanged — nothing written
  });

  it("set fails when the operator has not configured a server URL (MATTERMOST_HOST unset)", async () => {
    const { svc } = build({ noHost: true });
    await expect(svc.set("acme", { botTokenSecretName: "MM_BOT" })).rejects.toBeInstanceOf(BadRequestError);
    expect(await svc.get("acme")).toEqual({ connections: [] }); // no host, no connections
  });

  it("set fails when the bot token secret is missing from the SecretStore", async () => {
    const { svc } = build({ secrets: {} });
    await expect(svc.set("acme", { botTokenSecretName: "MM_BOT" })).rejects.toBeInstanceOf(BadRequestError);
  });

  it("updating without defaultChannelId preserves that connection's existing channel (and re-verifies)", async () => {
    const { svc } = build();
    await svc.set("acme", { botTokenSecretName: "MM_BOT", defaultChannelId: "ch" });
    await svc.set("acme", { botTokenSecretName: "MM_BOT2" });
    expect((await svc.get("acme")).connections).toEqual([
      { name: "default", botTokenSecretName: "MM_BOT2", defaultChannelId: "ch" },
    ]);
  });

  it("probe returns the classified connection-test outcome without persisting anything", async () => {
    const { svc } = build({
      verify: async () => ({ reachable: true, detail: "ok", botUsername: "bot", channelName: "General" }),
    });
    const result = await svc.probe("acme", { botTokenSecretName: "MM_BOT", defaultChannelId: "ch" });
    expect(result).toEqual({ reachable: true, detail: "ok", botUsername: "bot", channelName: "General" });
    expect((await svc.get("acme")).connections).toEqual([]); // probe never writes
  });

  describe("multiple connections (one bot + channel per team/purpose)", () => {
    it("registers several by name and keeps them side by side", async () => {
      const { svc } = build();
      await svc.set("acme", { name: "team-alerts", botTokenSecretName: "MM_BOT", defaultChannelId: "ch1" });
      await svc.set("acme", { name: "platform", botTokenSecretName: "MM_BOT2", defaultChannelId: "ch2" });
      expect((await svc.get("acme")).connections).toEqual([
        { name: "team-alerts", botTokenSecretName: "MM_BOT", defaultChannelId: "ch1" },
        { name: "platform", botTokenSecretName: "MM_BOT2", defaultChannelId: "ch2" },
      ]);
    });

    it("upserts by name — re-registering a name replaces that connection IN PLACE, never appends", async () => {
      const { svc } = build();
      await svc.set("acme", { name: "team-alerts", botTokenSecretName: "MM_BOT", defaultChannelId: "ch1" });
      await svc.set("acme", { name: "platform", botTokenSecretName: "MM_BOT2", defaultChannelId: "ch2" });
      await svc.set("acme", { name: "team-alerts", botTokenSecretName: "MM_BOT2", defaultChannelId: "ch9" });
      // Editing one connection must not reshuffle the list (the order IS the UI order + the default post target).
      expect((await svc.get("acme")).connections).toEqual([
        { name: "team-alerts", botTokenSecretName: "MM_BOT2", defaultChannelId: "ch9" },
        { name: "platform", botTokenSecretName: "MM_BOT2", defaultChannelId: "ch2" },
      ]);
    });

    it("removes one connection by name, leaving the others notifying", async () => {
      const { svc } = build();
      await svc.set("acme", { name: "team-alerts", botTokenSecretName: "MM_BOT", defaultChannelId: "ch1" });
      await svc.set("acme", { name: "platform", botTokenSecretName: "MM_BOT2", defaultChannelId: "ch2" });
      await svc.remove("acme", "team-alerts");
      expect((await svc.get("acme")).connections).toEqual([
        { name: "platform", botTokenSecretName: "MM_BOT2", defaultChannelId: "ch2" },
      ]);
      await svc.remove("acme", "team-alerts"); // idempotent
      expect((await svc.get("acme")).connections).toHaveLength(1);
    });

    it("migrates a legacy singular registration into the list as 'default' on read", async () => {
      const { svc } = build();
      await settings.set("acme", { mattermost: { botTokenSecretName: "MM_BOT", defaultChannelId: "ch" } });
      expect((await svc.get("acme")).connections).toEqual([
        { name: "default", botTokenSecretName: "MM_BOT", defaultChannelId: "ch" },
      ]);
      // …and the next write persists the plural list, voiding the legacy field.
      await svc.set("acme", { name: "extra", botTokenSecretName: "MM_BOT2", defaultChannelId: "ch2" });
      expect((await settings.get("acme"))?.mattermost).toBeNull();
      expect((await svc.get("acme")).connections.map((c) => c.name)).toEqual(["default", "extra"]);
    });
  });

  describe("postMessage (agent post_mattermost_message)", () => {
    it("posts to the configured default channel via the resolved bot token, returning the connection + channel", async () => {
      const { svc, client } = build();
      await svc.set("acme", { botTokenSecretName: "MM_BOT", defaultChannelId: "ch" });
      const out = await svc.postMessage("acme", "regression on suite X");
      expect(out).toEqual({ connection: "default", channelId: "ch" });
      expect(client.post).toHaveBeenCalledWith(HOST, "xoxb-token", {
        channelId: "ch",
        message: "regression on suite X",
      });
    });

    it("posts through the named connection with ITS bot token; an omitted name takes the first", async () => {
      const { svc, client } = build();
      await svc.set("acme", { name: "team-alerts", botTokenSecretName: "MM_BOT", defaultChannelId: "ch1" });
      await svc.set("acme", { name: "platform", botTokenSecretName: "MM_BOT2", defaultChannelId: "ch2" });
      expect(await svc.postMessage("acme", "hi", "platform")).toEqual({ connection: "platform", channelId: "ch2" });
      expect(client.post).toHaveBeenLastCalledWith(HOST, "xoxb-token-2", { channelId: "ch2", message: "hi" });
      expect(await svc.postMessage("acme", "hi")).toEqual({ connection: "team-alerts", channelId: "ch1" });
    });

    it("404s on an unknown connection name", async () => {
      const { svc, client } = build();
      await svc.set("acme", { name: "team-alerts", botTokenSecretName: "MM_BOT", defaultChannelId: "ch1" });
      await expect(svc.postMessage("acme", "hi", "nope")).rejects.toBeInstanceOf(NotFoundError);
      expect(client.post).not.toHaveBeenCalled();
    });

    it("throws when the workspace has not registered Mattermost", async () => {
      const { svc, client } = build();
      await expect(svc.postMessage("acme", "hi")).rejects.toBeInstanceOf(BadRequestError);
      expect(client.post).not.toHaveBeenCalled();
    });

    it("throws when the selected connection has no channel", async () => {
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
    const channels: MattermostChannel[] = [{ id: "c1", name: "town-square", displayName: "Town Square", type: "O" }];
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
