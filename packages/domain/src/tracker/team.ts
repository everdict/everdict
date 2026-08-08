import type { DomainFact, TeamRecord } from "@everdict/contracts";
import { BadRequestError, ConflictError, TEAM_KEY_PATTERN, formatIssueIdentifier } from "@everdict/contracts";
import { appendHistory } from "./history.js";

// The Team aggregate (docs/tracker.md) — the tracker's grouping layer. Transitions return {patch, facts} like
// Issue/Project/Initiative, so the store persists state and its fact in one transaction (E0). Transitions must
// never be spread — always use .patch.
export interface TeamTransition {
  patch: Partial<TeamRecord>;
  facts: DomainFact[];
}

export interface NewTeamInput {
  id: string;
  tenant: string;
  key: string;
  name: string;
  description?: string;
  isDefault: boolean;
  cyclesEnabled?: boolean;
  cycleDurationWeeks?: number;
  cycleStartDay?: number;
  upcomingCycleCount?: number;
  cycleAutoClose?: boolean;
  triageEnabled?: boolean;
  isPrivate?: boolean;
  // The team this one sits under. Organisational only — a sub-team still mints its own identifiers and owns its
  // own issues, so nesting never touches an issue's address. The service validates that the parent exists in the
  // same workspace and that the link introduces no cycle.
  parentId?: string;
  createdBy: string;
  now: string;
}

export interface TeamEditInput {
  name?: string;
  description?: string | null;
  cyclesEnabled?: boolean;
  cycleDurationWeeks?: number;
  cycleStartDay?: number;
  upcomingCycleCount?: number;
  cycleAutoClose?: boolean;
  triageEnabled?: boolean;
  isPrivate?: boolean;
  // `null` detaches the team from its parent (it becomes top-level again).
  parentId?: string | null;
}

// An allocation is a number AND the patch that consumed it: the caller cannot render an identifier without also
// persisting the counter move, which is what stops two issues from sharing `ENG-12`.
export interface IssueNumberAllocation {
  patch: Partial<TeamRecord>;
  number: number;
  identifier: string;
}

export function normalizeTeamKey(raw: string): string {
  return raw.trim().toUpperCase();
}

export class Team {
  private constructor(private readonly record: TeamRecord) {}

  static from(record: TeamRecord): Team {
    return new Team(record);
  }

  static newTeam(input: NewTeamInput): TeamRecord {
    const key = normalizeTeamKey(input.key);
    if (!TEAM_KEY_PATTERN.test(key))
      throw new BadRequestError(
        "BAD_REQUEST",
        { key: input.key },
        "A team key is 2–6 characters, uppercase letters or digits, starting with a letter.",
      );
    return {
      id: input.id,
      tenant: input.tenant,
      key,
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
      isDefault: input.isDefault,
      issueCounter: 0,
      cycleCounter: 0,
      // The team's own pace and whether work queues before its workflow — all editable afterwards, all with the
      // defaults a team that never thinks about any of them would want. Cycles start OFF: a rhythm nobody asked
      // for is a sidebar row nobody reads.
      cyclesEnabled: input.cyclesEnabled ?? false,
      cycleDurationWeeks: input.cycleDurationWeeks ?? 2,
      cycleStartDay: input.cycleStartDay ?? 1,
      upcomingCycleCount: input.upcomingCycleCount ?? 2,
      cycleAutoClose: input.cycleAutoClose ?? false,
      triageEnabled: input.triageEnabled ?? false,
      isPrivate: input.isPrivate ?? false,
      history: [
        {
          at: input.now,
          by: input.createdBy,
          event: "created",
          detail: {
            key,
            isDefault: input.isDefault,
            ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
          },
        },
      ],
      createdBy: input.createdBy,
      createdAt: input.now,
      updatedAt: input.now,
    };
  }

  static creationFacts(record: TeamRecord): DomainFact[] {
    return [
      {
        kind: "team.created",
        subject: { type: "team", id: record.id },
        actor: record.createdBy,
        payload: { key: record.key, isDefault: record.isDefault, name: record.name },
      },
    ];
  }

  get id(): string {
    return this.record.id;
  }

  get key(): string {
    return this.record.key;
  }

  get isDefault(): boolean {
    return this.record.isDefault;
  }

  // Content editing — no facts, mirroring Issue.update. The KEY is deliberately absent: it is baked into every
  // identifier this team ever minted, and rewriting those would break references people already pasted
  // elsewhere. `null` clears the description; `undefined` leaves a field alone.
  update(fields: TeamEditInput, by: string, now: string): TeamTransition {
    const changed: string[] = [];
    const patch: Partial<TeamRecord> = {};
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
    if (fields.cyclesEnabled !== undefined && fields.cyclesEnabled !== this.record.cyclesEnabled) {
      patch.cyclesEnabled = fields.cyclesEnabled;
      changed.push("cycles");
    }
    if (fields.cycleDurationWeeks !== undefined && fields.cycleDurationWeeks !== this.record.cycleDurationWeeks) {
      patch.cycleDurationWeeks = fields.cycleDurationWeeks;
      changed.push("cycleDuration");
    }
    if (fields.cycleStartDay !== undefined && fields.cycleStartDay !== this.record.cycleStartDay) {
      patch.cycleStartDay = fields.cycleStartDay;
      changed.push("cycleStartDay");
    }
    if (fields.upcomingCycleCount !== undefined && fields.upcomingCycleCount !== this.record.upcomingCycleCount) {
      patch.upcomingCycleCount = fields.upcomingCycleCount;
      changed.push("upcomingCycles");
    }
    if (fields.cycleAutoClose !== undefined && fields.cycleAutoClose !== this.record.cycleAutoClose) {
      patch.cycleAutoClose = fields.cycleAutoClose;
      changed.push("cycleAutoClose");
    }
    if (fields.triageEnabled !== undefined && fields.triageEnabled !== this.record.triageEnabled) {
      patch.triageEnabled = fields.triageEnabled;
      changed.push("triage");
    }
    if (fields.isPrivate !== undefined && fields.isPrivate !== this.record.isPrivate) {
      patch.isPrivate = fields.isPrivate;
      changed.push("visibility");
    }
    if (fields.parentId !== undefined) {
      const next = fields.parentId === null ? undefined : fields.parentId;
      if (next === this.record.id)
        throw new BadRequestError("BAD_REQUEST", { team: this.record.id }, "A team cannot be its own parent.");
      if (next !== this.record.parentId) {
        patch.parentId = next;
        changed.push("parent");
      }
    }
    if (changed.length === 0) throw new BadRequestError("BAD_REQUEST", { team: this.record.id }, "Nothing to update.");
    patch.history = appendHistory(this.record.history, { at: now, by, event: "updated", detail: { changed } });
    patch.updatedAt = now;
    return { patch, facts: [] };
  }

  // Hand the default flag over. Two writes, never one: the service clears the incumbent and promotes this team
  // in the same transaction, because "exactly one default" is the invariant that lets `teamId` stay required on
  // an issue while callers stay free to ignore teams entirely.
  promoteToDefault(by: string, now: string): TeamTransition {
    if (this.record.isDefault)
      throw new ConflictError("CONFLICT", { team: this.record.id }, `${this.record.name} is already the default team.`);
    return {
      patch: {
        isDefault: true,
        history: appendHistory(this.record.history, {
          at: now,
          by,
          event: "updated",
          detail: { changed: ["isDefault"], isDefault: true },
        }),
        updatedAt: now,
      },
      facts: [],
    };
  }

  demoteFromDefault(now: string): TeamTransition {
    if (!this.record.isDefault)
      throw new ConflictError("CONFLICT", { team: this.record.id }, `${this.record.name} is not the default team.`);
    return { patch: { isDefault: false, updatedAt: now }, facts: [] };
  }

  // The default team is the landing place for every issue filed without one, so removing it would leave the
  // workspace with no answer to "where does this go". Hand the flag to another team first — a deliberate,
  // explicit act rather than a silent re-election the member never asked for.
  assertDeletable(remainingTeams: number, openIssues: number, childTeams: number): void {
    if (this.record.isDefault)
      throw new ConflictError(
        "CONFLICT",
        { team: this.record.id },
        "This is the default team — make another team the default before deleting it.",
      );
    if (remainingTeams <= 0)
      throw new ConflictError(
        "CONFLICT",
        { team: this.record.id },
        "A workspace keeps at least one team — this is the last one.",
      );
    if (openIssues > 0)
      throw new ConflictError(
        "CONFLICT",
        { team: this.record.id, openIssues },
        `This team still holds ${openIssues} issue(s) — move them to another team first.`,
      );
    // Deleting a parent would strand its sub-teams under an id that resolves to nothing. Re-parenting them is a
    // decision (do they move up, or under a sibling?), so it stays the member's, made explicitly.
    if (childTeams > 0)
      throw new ConflictError(
        "CONFLICT",
        { team: this.record.id, childTeams },
        `This team still has ${childTeams} sub-team(s) — move or delete them first.`,
      );
  }

  // `<key>-<n>`, and the patch that consumes n. Callers persist the patch in the same write as the issue insert.
  allocateIssueNumber(now: string): IssueNumberAllocation {
    const next = this.record.issueCounter + 1;
    return {
      patch: { issueCounter: next, updatedAt: now },
      number: next,
      identifier: formatIssueIdentifier(this.record.key, next),
    };
  }

  // `Cycle n`, and the patch that consumes n — the same pairing as an issue number, for the same reason: the
  // caller cannot render the number without also persisting the move that spent it.
  allocateCycleNumber(now: string): { patch: Partial<TeamRecord>; number: number } {
    const next = this.record.cycleCounter + 1;
    return { patch: { cycleCounter: next, updatedAt: now }, number: next };
  }

  get cycleDurationWeeks(): number {
    return this.record.cycleDurationWeeks;
  }

  get triageEnabled(): boolean {
    return this.record.triageEnabled;
  }

  get isPrivate(): boolean {
    return this.record.isPrivate;
  }

  memberAdded(subject: string, by: string, now: string): TeamTransition {
    return {
      patch: {
        history: appendHistory(this.record.history, { at: now, by, event: "member_added", detail: { subject } }),
        updatedAt: now,
      },
      facts: [
        {
          kind: "team.member_added",
          subject: { type: "team", id: this.record.id },
          actor: by,
          payload: { member: subject, key: this.record.key, name: this.record.name },
        },
      ],
    };
  }

  memberRemoved(subject: string, by: string, now: string): TeamTransition {
    return {
      patch: {
        history: appendHistory(this.record.history, { at: now, by, event: "member_removed", detail: { subject } }),
        updatedAt: now,
      },
      facts: [
        {
          kind: "team.member_removed",
          subject: { type: "team", id: this.record.id },
          actor: by,
          payload: { member: subject, key: this.record.key, name: this.record.name },
        },
      ],
    };
  }
}
