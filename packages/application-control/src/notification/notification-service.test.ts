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
      feed: { add, list: vi.fn(async () => []), markRead: vi.fn(async () => 0), remove: vi.fn(async () => undefined) },
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

  it("an approval park in a conversation writes a feed row whose link is the conversation itself (N8)", async () => {
    const add = vi.fn(async () => undefined);
    const svc = new NotificationService({
      settingsFor: async () => undefined,
      feed: { add, list: vi.fn(async () => []), markRead: vi.fn(async () => 0), remove: vi.fn(async () => undefined) },
    });
    await svc.notifyApprovalRequested("acme", {
      recipient: "alice",
      tool: "write_file",
      place: { kind: "conversation", sessionId: "sess-1" },
    });
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "nf-approval-sess-1", // deterministic — a re-reported park deduplicates, the decision can clear it
        workspace: "acme",
        recipient: "alice",
        kind: "agent_approval_requested",
        title: "Approval needed — write_file",
        link: { conversationId: "sess-1" },
      }),
    );
  });

  it("the decision deletes the ask's row by the same deterministic key (a decided ask must not linger)", async () => {
    const remove = vi.fn(async () => undefined);
    const svc = new NotificationService({
      settingsFor: async () => undefined,
      feed: { add: vi.fn(async () => undefined), list: vi.fn(async () => []), markRead: vi.fn(async () => 0), remove },
    });
    await svc.clearApprovalRequest("acme", { kind: "conversation", sessionId: "sess-1" });
    await svc.clearApprovalRequest("acme", { kind: "discussion", commentId: "c9" });
    expect(remove).toHaveBeenNthCalledWith(1, "acme", "nf-approval-sess-1");
    expect(remove).toHaveBeenNthCalledWith(2, "acme", "nf-approval-c9");
  });

  it("an approval park in a discussion links the resource + agent comment, and no tool reads as a plan review", async () => {
    const add = vi.fn(async () => undefined);
    const svc = new NotificationService({
      settingsFor: async () => undefined,
      feed: { add, list: vi.fn(async () => []), markRead: vi.fn(async () => 0), remove: vi.fn(async () => undefined) },
    });
    await svc.notifyApprovalRequested("acme", {
      recipient: "bob",
      place: { kind: "discussion", resourceType: "harness", resourceId: "h1", commentId: "c1" },
    });
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "nf-approval-c1",
        recipient: "bob",
        kind: "agent_approval_requested",
        title: "Plan review needed",
        link: { resourceType: "harness", resourceId: "h1", commentId: "c1" },
      }),
    );
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
