import type { PlatformFact, ProjectRecord, ProjectStatus } from "@everdict/contracts";
import { BadRequestError, ConflictError } from "@everdict/contracts";
import { appendHistory } from "./history.js";

// The Project aggregate — issues grouped under one target date, so "did we finish the evaluation in time" is a
// question the tracker can answer instead of a spreadsheet. Same {patch, facts} transition contract as Issue.
export interface ProjectTransition {
  patch: Partial<ProjectRecord>;
  facts: PlatformFact[];
}

export interface NewProjectInput {
  id: string;
  tenant: string;
  name: string;
  description?: string;
  status?: ProjectStatus;
  initiativeId?: string;
  targetDate?: string;
  createdBy: string;
  now: string;
}

export interface ProjectEditInput {
  name?: string;
  description?: string | null;
  initiativeId?: string | null;
  targetDate?: string | null;
}

export interface ProjectStatusChangeInput {
  to: ProjectStatus;
  // How many of the project's issues are still open. The caller counts (it owns the store); the domain decides
  // what that count means — a project cannot claim completion while its issues are unresolved.
  openIssues: number;
  force?: boolean;
}

// Lexicographic comparison is correct for YYYY-MM-DD, and "did it land by the date" is arithmetic, not a
// judgment — the fact reports it, nobody infers "late" from a timestamp downstream.
function completedOnTime(targetDate: string | undefined, now: string): boolean | undefined {
  if (targetDate === undefined) return undefined;
  return now.slice(0, 10) <= targetDate;
}

export class Project {
  private constructor(private readonly record: ProjectRecord) {}

  static from(record: ProjectRecord): Project {
    return new Project(record);
  }

  static newProject(input: NewProjectInput): ProjectRecord {
    const status = input.status ?? "planned";
    return {
      id: input.id,
      tenant: input.tenant,
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      status,
      ...(input.initiativeId !== undefined ? { initiativeId: input.initiativeId } : {}),
      ...(input.targetDate !== undefined ? { targetDate: input.targetDate } : {}),
      history: [{ at: input.now, by: input.createdBy, event: "created", detail: { status } }],
      createdBy: input.createdBy,
      createdAt: input.now,
      updatedAt: input.now,
    };
  }

  static creationFacts(record: ProjectRecord): PlatformFact[] {
    return [
      {
        kind: "project.created",
        subject: { type: "project", id: record.id },
        actor: record.createdBy,
        payload: {
          status: record.status,
          ...(record.initiativeId !== undefined ? { initiativeId: record.initiativeId } : {}),
          ...(record.targetDate !== undefined ? { targetDate: record.targetDate } : {}),
        },
        message: `Project created — ${record.name}`,
      },
    ];
  }

  get status(): ProjectStatus {
    return this.record.status;
  }

  update(fields: ProjectEditInput, by: string, now: string): ProjectTransition {
    const changed: string[] = [];
    const patch: Partial<ProjectRecord> = {};
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
    if (fields.initiativeId !== undefined) {
      const next = fields.initiativeId === null ? undefined : fields.initiativeId;
      if (next !== this.record.initiativeId) {
        patch.initiativeId = next;
        changed.push("initiative");
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
      throw new BadRequestError("BAD_REQUEST", { project: this.record.id }, "Nothing to update.");
    patch.history = appendHistory(this.record.history, { at: now, by, event: "updated", detail: { changed } });
    patch.updatedAt = now;
    return { patch, facts: [] };
  }

  // The gate the whole tracker exists for: completing a project while its issues are open is refused, and the
  // refusal names the count. `force` is the deliberate override (a release ships with known gaps), and it is
  // recorded in the fact so the history says the deadline was overridden, not met.
  setStatus(input: ProjectStatusChangeInput, by: string, now: string): ProjectTransition {
    const from = this.record.status;
    const { to, openIssues } = input;
    if (to === from)
      throw new ConflictError("CONFLICT", { project: this.record.id, status: from }, `Project is already ${from}.`);
    if (to === "completed" && openIssues > 0 && input.force !== true)
      throw new ConflictError(
        "CONFLICT",
        { project: this.record.id, openIssues },
        `${openIssues} issue(s) are still open in this project — resolve them or complete it with force.`,
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
    const patch: Partial<ProjectRecord> = {
      status: to,
      history: appendHistory(this.record.history, {
        at: now,
        by,
        event: to === "completed" ? "completed" : to === "cancelled" ? "cancelled" : "status_changed",
        detail,
      }),
      updatedAt: now,
    };
    // completedAt marks the moment the project closed, and is cleared on reopen so a reopened project never
    // reads as finished.
    patch.completedAt = to === "completed" ? now : undefined;
    return {
      patch,
      facts: [
        {
          kind: "project.status_changed",
          subject: { type: "project", id: this.record.id },
          actor: by,
          payload: {
            from,
            to,
            openIssues,
            ...(this.record.initiativeId !== undefined ? { initiativeId: this.record.initiativeId } : {}),
            ...(onTime !== undefined ? { onTime } : {}),
            ...(forced ? { forced: true } : {}),
          },
          message: `Project ${from} → ${to} — ${this.record.name}`,
        },
      ],
    };
  }
}
