import type { InitiativeRecord, NotificationRecord, PlatformEventRecord, ProjectRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { InitiativeStore } from "../ports/initiative-store.js";
import type { ProjectStore } from "../ports/project-store.js";
import { trackerUpdateConsumer } from "./tracker-update-consumer.js";

const NOW = "2026-08-04T00:00:00.000Z";

const event = (over: Partial<PlatformEventRecord>): PlatformEventRecord => ({
  id: "ev-1",
  seq: 1,
  tenant: "acme",
  kind: "initiative.update_posted",
  subject: { type: "initiative", id: "ini-1" },
  actor: "dana",
  payload: { health: "at_risk", excerpt: "The judge rewrite slipped a week." },
  message: "agents people trust — at risk",
  createdAt: NOW,
  ...over,
});

function initiative(over: Partial<InitiativeRecord> = {}): InitiativeRecord {
  return {
    id: "ini-1",
    tenant: "acme",
    name: "agents people trust",
    status: "active",
    history: [],
    createdBy: "erin",
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function project(over: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: "p1",
    tenant: "acme",
    name: "conversation quality",
    status: "in_progress",
    teamIds: ["team-eng"],
    initiativeIds: ["ini-1"],
    memberIds: [],
    milestones: [],
    history: [],
    createdBy: "erin",
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

// Only the reads the consumer makes — a fake rather than the in-memory stores, because those live in
// @everdict/db and this package may not depend on its own adapter.
function stores(initiatives: InitiativeRecord[], projects: ProjectRecord[]) {
  const feed: NotificationRecord[] = [];
  const deps = {
    initiatives: {
      async get(tenant: string, id: string) {
        return initiatives.find((row) => row.tenant === tenant && row.id === id);
      },
    } as InitiativeStore,
    projects: {
      async get(tenant: string, id: string) {
        return projects.find((row) => row.tenant === tenant && row.id === id);
      },
      async list(tenant: string, filter?: { initiativeId?: string }) {
        return projects.filter(
          (row) =>
            row.tenant === tenant &&
            (filter?.initiativeId === undefined || row.initiativeIds.includes(filter.initiativeId)),
        );
      },
    } as ProjectStore,
    feed: {
      async add(record: NotificationRecord) {
        feed.push(record);
      },
    } as never,
  };
  return { deps, feed };
}

describe("trackerUpdateConsumer — a posted update reaches the people answerable for the work", () => {
  it("notifies the goal's lead, its creator and the leads of the projects under it — never the poster", async () => {
    const { deps, feed } = stores(
      [initiative({ lead: "dana", createdBy: "erin" })],
      [project({ lead: "finn" }), project({ id: "p2", lead: "gus", initiativeIds: ["other"] })],
    );

    await trackerUpdateConsumer(deps).handle(event({}));

    // dana posted it, so dana is dropped; gus's project belongs to a different goal.
    expect(feed.map((row) => row.recipient).sort()).toEqual(["erin", "finn"]);
    expect(feed[0]).toMatchObject({
      kind: "tracker_update_posted",
      title: "agents people trust — at risk",
      body: "The judge rewrite slipped a week.",
      link: { resourceType: "initiative", resourceId: "ini-1" },
    });
  });

  it("notifies a project's lead, members and creator on its own update", async () => {
    const { deps, feed } = stores([], [project({ lead: "dana", memberIds: ["gus", "dana"], createdBy: "erin" })]);

    await trackerUpdateConsumer(deps).handle(
      event({
        kind: "project.update_posted",
        subject: { type: "project", id: "p1" },
        actor: "gus",
        payload: { health: "off_track", excerpt: "Two datasets are still unlabelled." },
        message: "conversation quality — off track",
      }),
    );

    // Deduped (dana is both lead and member) and without the author.
    expect(feed.map((row) => row.recipient).sort()).toEqual(["dana", "erin"]);
    expect(feed[0]?.link).toEqual({ resourceType: "project", resourceId: "p1" });
  });

  it("keys rows on the event so a cursor rewind writes no duplicates", async () => {
    const { deps, feed } = stores([initiative({ lead: "dana" })], []);
    await trackerUpdateConsumer(deps).handle(event({ actor: "erin" }));
    await trackerUpdateConsumer(deps).handle(event({ actor: "erin" }));
    expect(feed.map((row) => row.id)).toEqual(["nf-ev-1-0", "nf-ev-1-0"]); // same natural key → the store upserts
  });

  it("stays quiet when the record is gone or the fact carries no health", async () => {
    const { deps, feed } = stores([], []);
    await trackerUpdateConsumer(deps).handle(event({})); // initiative deleted between write and sweep
    await trackerUpdateConsumer(deps).handle(event({ payload: {} }));
    expect(feed).toEqual([]);
  });
});
