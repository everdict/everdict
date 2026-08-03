import type { InitiativeRecord, InitiativeStatus, PlatformFact } from "@everdict/contracts";
import { BadRequestError, ConflictError } from "@everdict/contracts";
import { appendHistory } from "./history.js";

// The Initiative aggregate — the deployment umbrella. Completing one is the release gate: it refuses while any
// issue under any of its projects is still open, which is the check a team wants before shipping.
export interface InitiativeTransition {
  patch: Partial<InitiativeRecord>;
  facts: PlatformFact[];
}

export interface NewInitiativeInput {
  id: string;
  tenant: string;
  name: string;
  description?: string;
  // The initiative this one rolls up into. Readiness walks DOWN the tree, so a parent's release gate answers for
  // every descendant's projects too — the service validates existence + acyclicity before the link is written.
  parentId?: string;
  targetDate?: string;
  createdBy: string;
  now: string;
}

export interface InitiativeEditInput {
  name?: string;
  description?: string | null;
  // `null` detaches it from its parent (it becomes a top-level initiative again).
  parentId?: string | null;
  targetDate?: string | null;
}

export interface InitiativeStatusChangeInput {
  to: InitiativeStatus;
  // Open issues across every non-cancelled project under this initiative (the readiness verdict's count).
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

  // The release gate. Refusing here is the point: "are all the issues under this deployment resolved" gets a
  // definite answer instead of a hopeful one, and shipping anyway is an explicit, recorded override.
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
        `${openIssues} issue(s) are still open under this initiative — resolve them or complete it with force.`,
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
