import type {
  DomainFact,
  InitiativeRecord,
  InitiativeResource,
  InitiativeStatus,
  InitiativeUpdateRecord,
  TrackerHealth,
} from "@everdict/contracts";
import { BadRequestError, ConflictError } from "@everdict/contracts";
import { appendHistory } from "./history.js";
import { excerptOf } from "./update-excerpt.js";

// The Initiative aggregate — the GOAL several projects work toward (Linear's meaning). Completing one is a
// gate: it refuses while any issue under any of its projects is still open, because a goal with unfinished work
// under it has not been reached. Progress is arithmetic; health is the human's report on top of it.
export interface InitiativeTransition {
  patch: Partial<InitiativeRecord>;
  facts: DomainFact[];
}

export interface NewInitiativeInput {
  id: string;
  tenant: string;
  name: string;
  description?: string;
  // The initiative this one rolls up into. Progress walks DOWN the tree, so a parent answers for every
  // descendant's projects too — the service validates existence + acyclicity before the link is written.
  parentId?: string;
  lead?: string;
  memberIds?: string[];
  icon?: string;
  resources?: InitiativeResource[];
  targetDate?: string;
  createdBy: string;
  now: string;
}

export interface InitiativeEditInput {
  name?: string;
  description?: string | null;
  // `null` detaches it from its parent (it becomes a top-level initiative again).
  parentId?: string | null;
  // `null` clears the lead — nobody is answerable for the goal yet, which is a real state and not an error.
  lead?: string | null;
  // A list REPLACES what is there: an editor sends the resulting set, and a patch that merged would make
  // removal unexpressible (the same rule a project's member list follows).
  memberIds?: string[];
  icon?: string | null;
  resources?: InitiativeResource[];
  targetDate?: string | null;
}

export interface InitiativeStatusChangeInput {
  to: InitiativeStatus;
  // Open issues across every non-cancelled project under this initiative (the progress read's count).
  openIssues: number;
  force?: boolean;
}

// Deduped, order preserved — the caller's order is the display order, and a repeat would show one person twice.
function normalizeIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function completedOnTime(targetDate: string | undefined, now: string): boolean | undefined {
  if (targetDate === undefined) return undefined;
  return now.slice(0, 10) <= targetDate;
}

export class Initiative {
  private constructor(private readonly record: InitiativeRecord) {}

  static from(record: InitiativeRecord): Initiative {
    return new Initiative(record);
  }

  static newInitiative(input: NewInitiativeInput): InitiativeRecord {
    return {
      id: input.id,
      tenant: input.tenant,
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.icon !== undefined ? { icon: input.icon } : {}),
      // A goal starts PLANNED: what it means and which projects serve it is still being decided, and calling
      // that active made every idea look like work in flight.
      status: "planned",
      ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
      ...(input.lead !== undefined ? { lead: input.lead } : {}),
      memberIds: normalizeIds(input.memberIds ?? []),
      resources: input.resources ?? [],
      ...(input.targetDate !== undefined ? { targetDate: input.targetDate } : {}),
      history: [
        {
          at: input.now,
          by: input.createdBy,
          event: "created",
          detail: { status: "planned", ...(input.parentId !== undefined ? { parentId: input.parentId } : {}) },
        },
      ],
      createdBy: input.createdBy,
      createdAt: input.now,
      updatedAt: input.now,
    };
  }

  static creationFacts(record: InitiativeRecord): DomainFact[] {
    return [
      {
        kind: "initiative.created",
        subject: { type: "initiative", id: record.id },
        actor: record.createdBy,
        payload: {
          status: record.status,
          // Same reason the project fact names itself: a goal's id is a uuid, and the feed row is the reader.
          name: record.name,
          ...(record.targetDate !== undefined ? { targetDate: record.targetDate } : {}),
        },
      },
    ];
  }

  get status(): InitiativeStatus {
    return this.record.status;
  }

  update(fields: InitiativeEditInput, by: string, now: string): InitiativeTransition {
    const changed: string[] = [];
    const patch: Partial<InitiativeRecord> = {};
    if (fields.name !== undefined && fields.name !== this.record.name) {
      patch.name = fields.name;
      changed.push("name");
    }
    if (fields.description !== undefined) {
      const next = fields.description === null ? undefined : fields.description;
      if (next !== this.record.description) {
        patch.description = next;
        changed.push("description");
      }
    }
    if (fields.parentId !== undefined) {
      const next = fields.parentId === null ? undefined : fields.parentId;
      if (next === this.record.id)
        throw new BadRequestError(
          "BAD_REQUEST",
          { initiative: this.record.id },
          "An initiative cannot be its own parent.",
        );
      if (next !== this.record.parentId) {
        patch.parentId = next;
        changed.push("parent");
      }
    }
    if (fields.lead !== undefined) {
      const next = fields.lead === null ? undefined : fields.lead;
      if (next !== this.record.lead) {
        patch.lead = next;
        changed.push("lead");
      }
    }
    if (fields.icon !== undefined) {
      const next = fields.icon === null ? undefined : fields.icon;
      if (next !== this.record.icon) {
        patch.icon = next;
        changed.push("icon");
      }
    }
    if (fields.memberIds !== undefined) {
      const next = normalizeIds(fields.memberIds);
      if (next.join("\u0000") !== this.record.memberIds.join("\u0000")) {
        patch.memberIds = next;
        changed.push("members");
      }
    }
    if (fields.resources !== undefined) {
      const same =
        fields.resources.length === this.record.resources.length &&
        fields.resources.every(
          (resource, i) =>
            resource.url === this.record.resources[i]?.url && resource.label === this.record.resources[i]?.label,
        );
      if (!same) {
        patch.resources = fields.resources;
        changed.push("resources");
      }
    }
    if (fields.targetDate !== undefined) {
      const next = fields.targetDate === null ? undefined : fields.targetDate;
      if (next !== this.record.targetDate) {
        patch.targetDate = next;
        changed.push("targetDate");
      }
    }
    if (changed.length === 0)
      throw new BadRequestError("BAD_REQUEST", { initiative: this.record.id }, "Nothing to update.");
    patch.history = appendHistory(this.record.history, { at: now, by, event: "updated", detail: { changed } });
    patch.updatedAt = now;
    return { patch, facts: [] };
  }

  // Posting an update on the GOAL — the same judgment a project reports, one level up, and the only thing on an
  // initiative a human authors rather than derives. The initiative keeps the latest health so a list row shows
  // it without reading the timeline; the timeline keeps the sentence that explains it.
  postUpdate(
    update: { id: string; health: TrackerHealth; body: string },
    by: string,
    now: string,
  ): { transition: InitiativeTransition; record: InitiativeUpdateRecord } {
    if (update.body.trim().length === 0)
      throw new BadRequestError(
        "BAD_REQUEST",
        { initiative: this.record.id },
        "An update says where the goal stands — a health flag with no sentence is not an update.",
      );
    const from = this.record.health;
    return {
      transition: {
        patch: {
          health: update.health,
          history: appendHistory(this.record.history, {
            at: now,
            by,
            event: "update_posted",
            detail: { health: update.health, ...(from !== undefined ? { from } : {}) },
          }),
          updatedAt: now,
        },
        facts: [
          {
            kind: "initiative.update_posted",
            subject: { type: "initiative", id: this.record.id },
            actor: by,
            payload: {
              health: update.health,
              name: this.record.name,
              ...(from !== undefined ? { from } : {}),
              // The first line of what was said, not the whole thing: every downstream reader of this fact
              // (the bell row, the chat post) needs the sentence to be worth anything, and none of them can
              // re-read the timeline from an event. The full body stays the record.
              excerpt: excerptOf(update.body),
            },
          },
        ],
      },
      record: {
        id: update.id,
        tenant: this.record.tenant,
        initiativeId: this.record.id,
        health: update.health,
        body: update.body,
        createdBy: by,
        createdAt: now,
      },
    };
  }

  // The completion gate. Refusing here is the point: "is everything this goal asked for actually finished" gets
  // a definite answer instead of a hopeful one, and closing it anyway is an explicit, recorded override.
  setStatus(input: InitiativeStatusChangeInput, by: string, now: string): InitiativeTransition {
    const from = this.record.status;
    const { to, openIssues } = input;
    if (to === from)
      throw new ConflictError(
        "CONFLICT",
        { initiative: this.record.id, status: from },
        `Initiative is already ${from}.`,
      );
    if (to === "completed" && openIssues > 0 && input.force !== true)
      throw new ConflictError(
        "CONFLICT",
        { initiative: this.record.id, openIssues },
        `${openIssues} issue(s) under this initiative are still open — finish them, or complete it with force.`,
      );
    const onTime = to === "completed" ? completedOnTime(this.record.targetDate, now) : undefined;
    const forced = to === "completed" && openIssues > 0;
    const detail = {
      from,
      to,
      openIssues,
      ...(onTime !== undefined ? { onTime } : {}),
      ...(forced ? { forced: true } : {}),
    };
    const patch: Partial<InitiativeRecord> = {
      status: to,
      history: appendHistory(this.record.history, {
        at: now,
        by,
        event: to === "completed" ? "completed" : to === "cancelled" ? "cancelled" : "status_changed",
        detail,
      }),
      updatedAt: now,
    };
    patch.completedAt = to === "completed" ? now : undefined;
    return {
      patch,
      facts: [
        {
          kind: "initiative.status_changed",
          subject: { type: "initiative", id: this.record.id },
          actor: by,
          payload: {
            from,
            to,
            name: this.record.name,
            openIssues,
            ...(onTime !== undefined ? { onTime } : {}),
            ...(forced ? { forced: true } : {}),
          },
        },
      ],
    };
  }
}
