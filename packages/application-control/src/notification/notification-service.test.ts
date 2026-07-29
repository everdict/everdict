import { describe, expect, it, vi } from "vitest";
import { NotificationService } from "./notification-service.js";

// A completed scorecard the creator initiated — the minimal shape notifyScorecard reads. The
// scorecard.completed/failed platform FACT moved to the E0 outbox (ScorecardBatch.succeed/fail computes it,
// the settle persists it — covered by the domain tests); this service keeps feed + Mattermost only.
const scorecard = {
  id: "sc_9",
  status: "succeeded",
  createdBy: "alice",
  dataset: { id: "d", version: "1" },
  harness: { id: "h", version: "1" },
};

function feedSpy() {
  return {
    add: vi.fn(async () => undefined),
    list: vi.fn(async () => []),
    markRead: vi.fn(async () => 0),
  };
}

describe("NotificationService — scorecard feed channel", () => {
  it("pushes a feed entry addressed at the creator", async () => {
    const feed = feedSpy();
    const svc = new NotificationService({ settingsFor: async () => undefined, feed });
    await svc.notifyScorecard("acme", scorecard);
    expect(feed.add).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: "acme",
        recipient: "alice",
        kind: "scorecard_completed",
        link: { scorecardId: "sc_9" },
      }),
    );
  });

  it("uses the failed kind for a failed scorecard", async () => {
    const feed = feedSpy();
    const svc = new NotificationService({ settingsFor: async () => undefined, feed });
    await svc.notifyScorecard("acme", { ...scorecard, status: "failed" });
    expect(feed.add).toHaveBeenCalledWith(expect.objectContaining({ kind: "scorecard_failed" }));
  });

  it("brands a schedule-fired batch as a scheduled run", async () => {
    const feed = feedSpy();
    const svc = new NotificationService({ settingsFor: async () => undefined, feed });
    await svc.notifyScorecard("acme", { ...scorecard, origin: { source: "schedule" } });
    expect(feed.add).toHaveBeenCalledWith(expect.objectContaining({ kind: "schedule_completed" }));
  });

  it("does not push without a creator (nobody to notify)", async () => {
    const feed = feedSpy();
    const svc = new NotificationService({ settingsFor: async () => undefined, feed });
    await svc.notifyScorecard("acme", { ...scorecard, createdBy: undefined });
    expect(feed.add).not.toHaveBeenCalled();
  });

  it("swallows a feed failure so it never affects the result", async () => {
    const svc = new NotificationService({
      settingsFor: async () => undefined,
      feed: {
        ...feedSpy(),
        add: vi.fn(async () => {
          throw new Error("feed down");
        }),
      },
    });
    await expect(svc.notifyScorecard("acme", scorecard)).resolves.toBeUndefined();
  });
});
