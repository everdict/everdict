import { describe, expect, it, vi } from "vitest";
import { NotificationService } from "./notification-service.js";

// A completed scorecard the creator initiated — the minimal shape notifyScorecard reads.
const scorecard = {
  id: "sc_9",
  status: "succeeded",
  createdBy: "alice",
  dataset: { id: "d", version: "1" },
  harness: { id: "h", version: "1" },
};

describe("NotificationService — platform-event channel", () => {
  it("records a scorecard completion fact addressed at the creator", async () => {
    const emit = vi.fn(async () => undefined);
    const svc = new NotificationService({ settingsFor: async () => undefined, events: { emit } });
    await svc.notifyScorecard("acme", { ...scorecard, summary: [{ passRate: 0.5 }] });
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: "acme",
        recipient: "alice",
        kind: "scorecard.completed",
        subject: { type: "scorecard", id: "sc_9" },
        payload: expect.objectContaining({ status: "succeeded", passRate: 0.5 }),
      }),
    );
  });

  it("uses the failed kind for a failed scorecard", async () => {
    const emit = vi.fn(async () => undefined);
    const svc = new NotificationService({ settingsFor: async () => undefined, events: { emit } });
    await svc.notifyScorecard("acme", { ...scorecard, status: "failed" });
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ kind: "scorecard.failed" }));
  });

  it("does not record without a creator (nobody to wake)", async () => {
    const emit = vi.fn(async () => undefined);
    const svc = new NotificationService({ settingsFor: async () => undefined, events: { emit } });
    await svc.notifyScorecard("acme", { ...scorecard, createdBy: undefined });
    expect(emit).not.toHaveBeenCalled();
  });

  it("swallows an emitter failure so it never affects the result", async () => {
    const svc = new NotificationService({
      settingsFor: async () => undefined,
      events: {
        emit: async () => {
          throw new Error("event channel down");
        },
      },
    });
    await expect(svc.notifyScorecard("acme", scorecard)).resolves.toBeUndefined();
  });
});
