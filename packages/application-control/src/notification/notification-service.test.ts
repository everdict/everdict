import { describe, expect, it, vi } from "vitest";
import { NotificationService } from "./notification-service.js";

// BOTH completion channels now ride the event log (E1): the feed via feed:runs/feed:scorecards, the
// Mattermost channel via the mm:completions consumer driving postChannelMessage. This service keeps the
// feed store surface, the report fan-out, and the Mattermost transport behind that one poster.
describe("NotificationService — the channel poster after the full E1 re-base", () => {
  it("postChannelMessage never writes the feed (the cursor consumers own the bell rows)", async () => {
    const add = vi.fn(async () => undefined);
    const svc = new NotificationService({
      settingsFor: async () => undefined,
      feed: { add, list: vi.fn(async () => []), markRead: vi.fn(async () => 0) },
    });
    await svc.postChannelMessage("acme", "✅ **Scorecard `sc_9`** succeeded");
    expect(add).not.toHaveBeenCalled();
  });

  it("swallows a channel failure so a Mattermost outage never affects the caller (fire-and-forget mirror)", async () => {
    const svc = new NotificationService({
      settingsFor: async () => {
        throw new Error("settings down");
      },
    });
    await expect(svc.postChannelMessage("acme", "boom test")).resolves.toBeUndefined();
  });

  it("posts to the workspace channel when the transport, host, channel and bot token are all configured", async () => {
    const post = vi.fn(async () => undefined);
    const svc = new NotificationService({
      settingsFor: async () => ({
        mattermost: { defaultChannelId: "ch-1", botTokenSecretName: "MM_BOT" },
      }),
      secretsFor: async () => ({ MM_BOT: "xoxb-test" }),
      mattermostHost: "https://mm.corp.io",
      mattermost: { post, verify: vi.fn(), listChannels: vi.fn(), getChannelPosts: vi.fn() } as never,
    });
    await svc.postChannelMessage("acme", "✅ **Run `r1`** succeeded — `h@1` (case c1)");
    expect(post).toHaveBeenCalledWith(
      "https://mm.corp.io",
      "xoxb-test",
      expect.objectContaining({ channelId: "ch-1", message: expect.stringContaining("Run `r1`") }),
    );
  });
});
