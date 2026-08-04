import type { NotificationRecord, PlatformEventRecord } from "@everdict/contracts";
import type { PlatformEventConsumer } from "../platform-event/event-consumer-runner.js";
import type { InitiativeStore } from "../ports/initiative-store.js";
import type { NotificationStore } from "../ports/notification-store.js";
import type { ProjectStore } from "../ports/project-store.js";

// Posted updates have to REACH somebody (docs/tracker.md). Health is the one judgment the tracker records, and
// until this consumer existed it landed in a timeline nobody was watching — which made posting one a private
// act. A durable-cursor consumer over the two `*.update_posted` facts turns it into news for the people who are
// answerable for that work.
//
// Recipients are DERIVED from the record, never subscribed: everdict has no subscription table for tracker
// records, and inventing one to answer "who cares" would be a worse answer than the record already gives.
// A project's update goes to its lead, its members and whoever created it; a goal's update goes to its lead,
// its creator, and the leads of the projects under it — the people whose work the goal is made of. The poster
// is always dropped: nobody needs to be told what they just said.

export interface TrackerUpdateConsumerDeps {
  projects: ProjectStore;
  initiatives: InitiativeStore;
  feed: NotificationStore;
}

function payloadString(event: PlatformEventRecord, key: string): string | undefined {
  const value = event.payload[key];
  return typeof value === "string" ? value : undefined;
}

// "off track" reads better than "off_track" in a sentence somebody is skimming in a bell.
function healthLabel(health: string): string {
  return health.replace("_", " ");
}

export function trackerUpdateConsumer(deps: TrackerUpdateConsumerDeps): PlatformEventConsumer {
  return {
    name: "tracker:update-notify",
    kinds: ["project.update_posted", "initiative.update_posted"],
    async handle(event) {
      const health = payloadString(event, "health");
      if (health === undefined) return; // a malformed fact is not worth a bell row
      const excerpt = payloadString(event, "excerpt");

      let name: string;
      let recipients: string[];
      if (event.kind === "initiative.update_posted") {
        const initiative = await deps.initiatives.get(event.tenant, event.subject.id);
        if (!initiative) return; // deleted between the write and the sweep — nothing to link to
        const under = await deps.projects.list(event.tenant, { initiativeId: initiative.id });
        name = initiative.name;
        recipients = [initiative.lead, initiative.createdBy, ...under.map((project) => project.lead)].filter(
          (subject): subject is string => subject !== undefined,
        );
      } else {
        const project = await deps.projects.get(event.tenant, event.subject.id);
        if (!project) return;
        name = project.name;
        recipients = [project.lead, project.createdBy, ...project.memberIds].filter(
          (subject): subject is string => subject !== undefined,
        );
      }

      const subject = event.kind === "initiative.update_posted" ? "initiative" : "project";
      // Deduped, and never back to the author — `event.actor` is who posted it.
      const audience = [...new Set(recipients)].filter((recipient) => recipient !== event.actor);
      for (const [index, recipient] of audience.entries()) {
        const record: NotificationRecord = {
          // Idempotent by the natural key, like every other feed row — a cursor rewind writes no duplicates.
          id: `nf-${event.id}-${index}`,
          workspace: event.tenant,
          recipient,
          kind: "tracker_update_posted",
          title: `${name} — ${healthLabel(health)}`,
          ...(excerpt !== undefined ? { body: excerpt } : {}),
          link: { resourceType: subject, resourceId: event.subject.id },
          createdAt: event.createdAt,
        };
        await deps.feed.add(record);
      }
    },
  };
}
