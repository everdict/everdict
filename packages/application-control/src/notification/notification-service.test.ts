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

describe("NotificationService — agent event bridge (S4)", () => {
  it("pushes a scorecard completion to the agent sink for the creator", async () => {
    const emit = vi.fn(async () => {});
    const svc = new NotificationService({ settingsFor: async () => undefined, agentEvents: { emit } });
    await svc.notifyScorecard("acme", scorecard);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: "acme", recipient: "alice", kind: "scorecard.completed" }),
    );
  });

  it("uses the failed kind for a failed scorecard", async () => {
    const emit = vi.fn(async () => {});
    const svc = new NotificationService({ settingsFor: async () => undefined, agentEvents: { emit } });
    await svc.notifyScorecard("acme", { ...scorecard, status: "failed" });
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ kind: "scorecard.failed" }));
  });

  it("does not push without a creator (nobody to wake)", async () => {
    const emit = vi.fn(async () => {});
    const svc = new NotificationService({ settingsFor: async () => undefined, agentEvents: { emit } });
    await svc.notifyScorecard("acme", { ...scorecard, createdBy: undefined });
    expect(emit).not.toHaveBeenCalled();
  });

  it("swallows an agent-sink failure so it never affects the result", async () => {
    const svc = new NotificationService({
      settingsFor: async () => undefined,
      agentEvents: {
        emit: async () => {
          throw new Error("agent unreachable");
        },
      },
    });
    await expect(svc.notifyScorecard("acme", scorecard)).resolves.toBeUndefined();
  });
});
