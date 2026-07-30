import type { PlatformEventRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { mattermostConsumer } from "./mattermost-consumer.js";

function poster() {
  const posts: Array<{ tenant: string; message: string; rerun?: { dataset: string; harness: string } }> = [];
  return {
    posts,
    async postChannelMessage(tenant: string, message: string, rerun?: { dataset: string; harness: string }) {
      posts.push({ tenant, message, ...(rerun ? { rerun } : {}) });
    },
  };
}

const event = (over: Partial<PlatformEventRecord>): PlatformEventRecord => ({
  id: "ev-1",
  seq: 1,
  tenant: "acme",
  kind: "run.completed",
  subject: { type: "run", id: "r1" },
  payload: {},
  message: "Run r1 succeeded",
  createdAt: "2026-07-30T00:00:00.000Z",
  ...over,
});

describe("mattermostConsumer — the channel rides the log (the last direct notification path, re-based)", () => {
  it("posts run completions with the old direct-path formatting (parity)", async () => {
    const channel = poster();
    await mattermostConsumer(channel).handle(
      event({ payload: { status: "succeeded", harness: "hermes@1.0.0", caseId: "c1" } }),
    );
    expect(channel.posts).toEqual([
      { tenant: "acme", message: "✅ **Run `r1`** succeeded — `hermes@1.0.0` (case c1)" },
    ]);
  });

  it("posts scorecard completions with the Rerun context carrying BARE ids (the @version is stripped)", async () => {
    const channel = poster();
    await mattermostConsumer(channel).handle(
      event({
        kind: "scorecard.completed",
        subject: { type: "scorecard", id: "sc-1" },
        payload: { status: "succeeded", dataset: "smoke@1.2.0", harness: "hermes@1.0.0", passRate: 0.5 },
      }),
    );
    expect(channel.posts[0]).toEqual({
      tenant: "acme",
      message: "✅ **Scorecard `sc-1`** succeeded — dataset `smoke@1.2.0` × `hermes@1.0.0`",
      rerun: { dataset: "smoke", harness: "hermes" },
    });
  });

  it("covers failed/cancelled icons and posts reports from the fact's own one-line rendering", async () => {
    const channel = poster();
    const consumer = mattermostConsumer(channel);
    await consumer.handle(
      event({
        kind: "scorecard.cancelled",
        subject: { type: "scorecard", id: "sc-2" },
        payload: { dataset: "d@1", harness: "h@1" },
      }),
    );
    await consumer.handle(
      event({
        kind: "report.completed",
        subject: { type: "view", id: "v1" },
        message: 'Scheduled report "weekly" is ready on view v1.',
      }),
    );
    expect(channel.posts[0]?.message).toContain("• **Scorecard `sc-2`** cancelled");
    expect(channel.posts[1]?.message).toBe('📈 Scheduled report "weekly" is ready on view v1.');
  });
});
