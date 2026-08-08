import type {
  DomainFact,
  ProjectMilestone,
  ProjectRecord,
  ProjectStatus,
  ProjectUpdateRecord,
  TrackerHealth,
} from "@everdict/contracts";
import { BadRequestError, ConflictError } from "@everdict/contracts";
import { appendHistory } from "./history.js";
import { excerptOf } from "./update-excerpt.js";

// The Project aggregate — issues grouped under one target date, so "did we finish the evaluation in time" is a
// question the tracker can answer instead of a spreadsheet. Same {patch, facts} transition contract as Issue.
export interface ProjectTransition {
  patch: Partial<ProjectRecord>;
  facts: DomainFact[];
}

export interface NewProjectInput {
  id: string;
  tenant: string;
  name: string;
  description?: string;
  status?: ProjectStatus;
  // The contributing teams and the umbrellas this project rolls up into — both lists, because a project spans
  // teams and can serve more than one initiative (records/tracker.ts explains why neither may be a single id).
  // The team list must not be EMPTY, though: the caller resolves "no teams named" to the workspace's default
  // team before it gets here, so an empty one at this point is a project nobody would ever see.
  teamIds?: string[];
  initiativeIds?: string[];
  lead?: string;
  memberIds?: string[];
  targetDate?: string;
  createdBy: string;
  now: string;
}

export interface ProjectEditInput {
  name?: string;
  description?: string | null;
  // A list REPLACES what is there — there is no add/remove verb, because a membership editor sends the
  // resulting set and a patch that merged would make removal unexpressible. `initiativeIds: []` detaches every
  // umbrella (a project under none is still a project); `teamIds: []` is refused — see `assertTeamed`.
  teamIds?: string[];
  initiativeIds?: string[];
  // `null` clears the lead (nobody is answerable yet); the member list REPLACES, like the other lists.
  lead?: string | null;
  memberIds?: string[];
  targetDate?: string | null;
}

// Deduped, order preserved: the caller's order is the display order, and a list that silently kept a repeat
// would double-count the same team in every rollup that walks it.
function normalizeIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

// A project is always somebody's work. Enforced in the aggregate rather than only at the edges because both
// ways in — creating one and editing its team list — end here, and an empty list is not a smaller project: it
// is one that appears in no team's sidebar and that no issue may join (an issue can only be in a project its
// own team is on), which is work made invisible rather than planned.
function assertTeamed(teamIds: readonly string[], project: string): void {
  if (teamIds.length === 0)
    throw new BadRequestError(
      "BAD_REQUEST",
      { project },
      "A project is worked by at least one team — name the team it belongs to instead of detaching the last one.",
    );
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
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
    const teamIds = normalizeIds(input.teamIds ?? []);
    assertTeamed(teamIds, input.id);
    const initiativeIds = normalizeIds(input.initiativeIds ?? []);
    return {
      id: input.id,
      tenant: input.tenant,
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      status,
      teamIds,
      initiativeIds,
      ...(input.lead !== undefined ? { lead: input.lead } : {}),
      memberIds: normalizeIds(input.memberIds ?? []),
      milestones: [],
      ...(input.targetDate !== undefined ? { targetDate: input.targetDate } : {}),
      history: [
        {
          at: input.now,
          by: input.createdBy,
          event: "created",
          detail: { status, teamIds, initiativeIds },
        },
      ],
      createdBy: input.createdBy,
      createdAt: input.now,
      updatedAt: input.now,
    };
  }

  static creationFacts(record: ProjectRecord): DomainFact[] {
    return [
      {
        kind: "project.created",
        subject: { type: "project", id: record.id },
        actor: record.createdBy,
        payload: {
          status: record.status,
          // The name a feed row cites — the record's id is a uuid, and a "project created" line that names
          // nothing tells a reader nothing.
          name: record.name,
          teamIds: record.teamIds,
          initiativeIds: record.initiativeIds,
          ...(record.targetDate !== undefined ? { targetDate: record.targetDate } : {}),
        },
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
    if (fields.teamIds !== undefined) {
      const next = normalizeIds(fields.teamIds);
      assertTeamed(next, this.record.id);
      if (!sameIds(next, this.record.teamIds)) {
        patch.teamIds = next;
        changed.push("teams");
      }
    }
    if (fields.initiativeIds !== undefined) {
      const next = normalizeIds(fields.initiativeIds);
      if (!sameIds(next, this.record.initiativeIds)) {
        patch.initiativeIds = next;
        changed.push("initiatives");
      }
    }
    if (fields.lead !== undefined) {
      const next = fields.lead === null ? undefined : fields.lead;
      if (next !== this.record.lead) {
        patch.lead = next;
        changed.push("lead");
      }
    }
    if (fields.memberIds !== undefined) {
      const next = normalizeIds(fields.memberIds);
      if (!sameIds(next, this.record.memberIds)) {
        patch.memberIds = next;
        changed.push("members");
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

  // Posting an update. This is the one JUDGMENT the tracker records — "at risk" is somebody saying so, not
  // arithmetic over the rollup — so the health rides WITH the sentence that explains it. The project keeps the
  // latest health so a list row can show it without reading the timeline per row; the update itself is the
  // record, and the record is what a reader goes to when the colour changed.
  postUpdate(
    update: { id: string; health: TrackerHealth; body: string },
    by: string,
    now: string,
  ): { transition: ProjectTransition; record: ProjectUpdateRecord } {
    if (update.body.trim().length === 0)
      throw new BadRequestError(
        "BAD_REQUEST",
        { project: this.record.id },
        "An update says what changed — a health flag with no sentence is not an update.",
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
            kind: "project.update_posted",
            subject: { type: "project", id: this.record.id },
            actor: by,
            payload: {
              health: update.health,
              name: this.record.name,
              ...(from !== undefined ? { from } : {}),
              // The same excerpt an initiative update carries, for the same reason: a bell row or a chat post
              // that only says the colour explains nothing, and neither can re-read the timeline.
              excerpt: excerptOf(update.body),
              teamIds: this.record.teamIds,
              initiativeIds: this.record.initiativeIds,
            },
          },
        ],
      },
      record: {
        id: update.id,
        tenant: this.record.tenant,
        projectId: this.record.id,
        health: update.health,
        body: update.body,
        createdBy: by,
        createdAt: now,
      },
    };
  }

  // Milestones are the project's own checkpoints, so they are content editing (one history entry, no fact) —
  // the same split every other structural edit makes. The order is the meaning: a milestone list is a sequence
  // of steps toward a date, so a new one goes at the end and `sortOrder` is what a reorder rewrites.
  addMilestone(milestone: Omit<ProjectMilestone, "sortOrder">, by: string, now: string): ProjectTransition {
    if (this.record.milestones.some((m) => m.name === milestone.name))
      throw new ConflictError(
        "CONFLICT",
        { project: this.record.id, name: milestone.name },
        "This project already has a milestone with that name.",
      );
    const sortOrder = this.record.milestones.reduce((max, m) => Math.max(max, m.sortOrder + 1), 0);
    const next = [...this.record.milestones, { ...milestone, sortOrder }];
    return {
      patch: {
        milestones: next,
        history: appendHistory(this.record.history, {
          at: now,
          by,
          event: "updated",
          detail: { changed: ["milestones"], added: milestone.name },
        }),
        updatedAt: now,
      },
      facts: [],
    };
  }

  removeMilestone(milestoneId: string, by: string, now: string): ProjectTransition {
    const gone = this.record.milestones.find((m) => m.id === milestoneId);
    if (!gone)
      throw new BadRequestError(
        "BAD_REQUEST",
        { project: this.record.id, milestone: milestoneId },
        "That milestone is not on this project.",
      );
    return {
      patch: {
        milestones: this.record.milestones.filter((m) => m.id !== milestoneId),
        history: appendHistory(this.record.history, {
          at: now,
          by,
          event: "updated",
          detail: { changed: ["milestones"], removed: gone.name },
        }),
        updatedAt: now,
      },
      facts: [],
    };
  }

  get milestones(): readonly ProjectMilestone[] {
    return this.record.milestones;
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
            name: this.record.name,
            openIssues,
            teamIds: this.record.teamIds,
            initiativeIds: this.record.initiativeIds,
            ...(onTime !== undefined ? { onTime } : {}),
            ...(forced ? { forced: true } : {}),
          },
        },
      ],
    };
  }
}
