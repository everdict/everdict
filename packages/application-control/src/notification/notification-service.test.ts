import { describe, expect, it, vi } from "vitest";
import { NotificationService } from "./notification-service.js";

// The scorecard/run FEED moved to the event log (E1 — see feed-consumers.test.ts): this service now owns
// only the Mattermost channel post for completions (plus the report/mention feeds, which have no facts yet).
const scorecard = {
  id: "sc_9",
  status: "succeeded",
  createdBy: "alice",
  dataset: { id: "d", version: "1" },
  harness: { id: "h", version: "1" },
};

describe("NotificationService — completion channels after the E1 re-base", () => {
  it("no longer writes the feed directly (the feed:scorecards cursor consumer owns the bell row)", async () => {
    const add = vi.fn(async () => undefined);
    const svc = new NotificationService({
      settingsFor: async () => undefined,
      feed: { add, list: vi.fn(async () => []), markRead: vi.fn(async () => 0) },
    });
    await svc.notifyScorecard("acme", scorecard);
    expect(add).not.toHaveBeenCalled();
  });

  it("swallows a channel failure so it never affects the result", async () => {
    const svc = new NotificationService({
      settingsFor: async () => {
        throw new Error("settings down");
      },
    });
    await expect(svc.notifyScorecard("acme", scorecard)).resolves.toBeUndefined();
  });
});
