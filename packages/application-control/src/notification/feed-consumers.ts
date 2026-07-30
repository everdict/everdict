import type { NotificationRecord, PlatformEventRecord } from "@everdict/contracts";
import type { PlatformEventConsumer } from "../platform-event/event-consumer-runner.js";
import type { NotificationStore } from "../ports/notification-store.js";

// The personal feed (bell inbox), re-based onto the event log (event-plumbing.md E1): the run/scorecard
// completion facts already carry EXACTLY the feed's gate (actor=recipient=createdBy, children silent), so
// the feed becomes a durable-cursor consumer instead of a direct call at the settle site — replayable,
// restart-proof, one delivery semantics. IDEMPOTENT BY NATURAL KEY: the feed row's id derives from the
// event id (`nf-<eventId>`), so a redelivery or a deliberate cursor rewind writes zero duplicates (the
// store ignores an existing id). Mattermost stays on the direct path for now — its coverage is WIDER than
// the facts (machine-fired completions post too), so re-basing it is an E2 coverage decision.

function payloadString(event: PlatformEventRecord, key: string): string {
  const value = event.payload[key];
  return typeof value === "string" ? value : "";
}

// run.completed / run.failed → run_completed / run_failed feed rows (parity with the old notifyRun feed).
export function runFeedConsumer(feed: NotificationStore): PlatformEventConsumer {
  return {
    name: "feed:runs",
    kinds: ["run.completed", "run.failed"],
    async handle(event) {
      const recipient = event.actor;
      if (!recipient) return; // the fact gate already excludes these; belt-and-braces
      const failed = event.kind === "run.failed";
      const record: NotificationRecord = {
        id: `nf-${event.id}`, // natural key — replay-safe
        workspace: event.tenant,
        recipient,
        kind: failed ? "run_failed" : "run_completed",
        title: `Run ${failed ? "failed" : "completed"} — ${payloadString(event, "harness")}`,
        body: `case ${payloadString(event, "caseId")}`,
        link: { runId: event.subject.id },
        createdAt: event.createdAt,
      };
      await feed.add(record);
    },
  };
}

// scorecard.completed / scorecard.failed → scorecard_/schedule_ feed rows (parity with the old
// notifyScorecard feed, incl. the schedule branding read from payload.origin).
export function scorecardFeedConsumer(feed: NotificationStore): PlatformEventConsumer {
  return {
    name: "feed:scorecards",
    kinds: ["scorecard.completed", "scorecard.failed"],
    async handle(event) {
      const recipient = event.actor;
      if (!recipient) return;
      const failed = event.kind === "scorecard.failed";
      const scheduled = payloadString(event, "origin") === "schedule";
      const verb = failed ? "failed" : "completed";
      const record: NotificationRecord = {
        id: `nf-${event.id}`,
        workspace: event.tenant,
        recipient,
        kind: scheduled
          ? failed
            ? "schedule_failed"
            : "schedule_completed"
          : failed
            ? "scorecard_failed"
            : "scorecard_completed",
        title: `${scheduled ? "Scheduled run" : "Scorecard"} ${verb} — ${payloadString(event, "dataset")} × ${payloadString(event, "harness")}`,
        link: { scorecardId: event.subject.id },
        createdAt: event.createdAt,
      };
      await feed.add(record);
    },
  };
}
