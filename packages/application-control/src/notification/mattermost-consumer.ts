import type { PlatformEventRecord } from "@everdict/contracts";
import type { PlatformEventConsumer } from "../platform-event/event-consumer-runner.js";
import type { ChannelPoster } from "./notification-service.js";

// The Mattermost channel, re-based onto the event log (event-plumbing.md E1 — the last direct notification
// path). One durable cursor ("mm:completions") posts every completion fact to the workspace channel; the
// E2 widening (initiator-less run/scorecard facts) restored the coverage the direct path had, so nothing
// machine-fired goes quiet. The channel is a MIRROR, not a ledger: the poster swallows transport failures
// exactly like the old fire-and-forget path (an MM outage skips posts, never dams the log), and the rare
// at-least-once redelivery duplicate is a chat message, not an effect.

const bareId = (labeled: string): string => {
  const at = labeled.lastIndexOf("@");
  return at > 0 ? labeled.slice(0, at) : labeled;
};

function payloadString(event: PlatformEventRecord, key: string): string {
  const value = event.payload[key];
  return typeof value === "string" ? value : "";
}

export function mattermostConsumer(channel: ChannelPoster): PlatformEventConsumer {
  return {
    name: "mm:completions",
    kinds: [
      "run.completed",
      "run.failed",
      "scorecard.completed",
      "scorecard.failed",
      "scorecard.cancelled",
      "report.completed",
    ],
    async handle(event) {
      if (event.kind === "run.completed" || event.kind === "run.failed") {
        const icon = event.kind === "run.completed" ? "✅" : "❌";
        const status = payloadString(event, "status") || (event.kind === "run.completed" ? "succeeded" : "failed");
        await channel.postChannelMessage(
          event.tenant,
          `${icon} **Run \`${event.subject.id}\`** ${status} — \`${payloadString(event, "harness")}\` (case ${payloadString(event, "caseId")})`,
        );
        return;
      }
      if (event.kind === "report.completed") {
        await channel.postChannelMessage(event.tenant, `📈 ${event.message}`);
        return;
      }
      const status =
        payloadString(event, "status") ||
        (event.kind === "scorecard.completed"
          ? "succeeded"
          : event.kind === "scorecard.failed"
            ? "failed"
            : "cancelled");
      const icon = status === "succeeded" ? "✅" : status === "failed" ? "❌" : "•";
      const dataset = payloadString(event, "dataset");
      const harness = payloadString(event, "harness");
      await channel.postChannelMessage(
        event.tenant,
        `${icon} **Scorecard \`${event.subject.id}\`** ${status} — dataset \`${dataset}\` × \`${harness}\``,
        { dataset: bareId(dataset), harness: bareId(harness) },
      );
    },
  };
}
