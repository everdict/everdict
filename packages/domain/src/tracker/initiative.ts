import type {
  InitiativeRecord,
  InitiativeStatus,
  InitiativeUpdateRecord,
  PlatformFact,
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
  facts: PlatformFact[];
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
  targetDate?: string | null;
}

export interface InitiativeStatusChangeInput {
  to: InitiativeStatus;
  // Open issues across every non-cancelled project under this initiative (the progress read's count).
  openIssues: number;
  force?: boolean;
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
      status: "active",
      ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
      ...(input.lead !== undefined ? { lead: input.lead } : {}),
      ...(input.targetDate !== undefined ? { targetDate: input.targetDate } : {}),
      history: [
        {
          at: input.now,
          by: input.createdBy,
          event: "created",
          detail: { status: "active", ...(input.parentId !== undefined ? { parentId: input.parentId } : {}) },
        },
      ],
      createdBy: input.createdBy,
      createdAt: input.now,
      updatedAt: input.now,
    };
  }

  static creationFacts(record: InitiativeRecord): PlatformFact[] {
    return [
      {
        kind: "initiative.created",
        subject: { type: "initiative", id: record.id },
        actor: record.createdBy,
        payload: {
          status: record.status,
          ...(record.targetDate !== undefined ? { targetDate: record.targetDate } : {}),
        },
        message: `Initiative created — ${record.name}`,
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
              ...(from !== undefined ? { from } : {}),
              // The first line of what was said, not the whole thing: every downstream reader of this fact
              // (the bell row, the chat post) needs the sentence to be worth anything, and none of them can
              // re-read the timeline from an event. The full body stays the record.
              excerpt: excerptOf(update.body),
            },
            message: `${this.record.name} — ${update.health.replace("_", " ")}`,
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
            openIssues,
            ...(onTime !== undefined ? { onTime } : {}),
            ...(forced ? { forced: true } : {}),
          },
          message: `Initiative ${from} → ${to} — ${this.record.name}`,
        },
      ],
    };
  }
}
