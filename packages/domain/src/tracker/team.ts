import type { PlatformFact, TeamRecord } from "@everdict/contracts";
import { BadRequestError, ConflictError, TEAM_KEY_PATTERN, formatIssueIdentifier } from "@everdict/contracts";
import { appendHistory } from "./history.js";

// The Team aggregate (docs/tracker.md) — the tracker's grouping layer. Transitions return {patch, facts} like
// Issue/Project/Initiative, so the store persists state and its fact in one transaction (E0). Transitions must
// never be spread — always use .patch.
export interface TeamTransition {
  patch: Partial<TeamRecord>;
  facts: PlatformFact[];
}

export interface NewTeamInput {
  id: string;
  tenant: string;
  key: string;
  name: string;
  description?: string;
  isDefault: boolean;
  createdBy: string;
  now: string;
}

export interface TeamEditInput {
  name?: string;
  description?: string | null;
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
      isDefault: input.isDefault,
      issueCounter: 0,
      history: [
        {
          at: input.now,
          by: input.createdBy,
          event: "created",
          detail: { key, isDefault: input.isDefault },
        },
      ],
      createdBy: input.createdBy,
      createdAt: input.now,
      updatedAt: input.now,
    };
  }

  static creationFacts(record: TeamRecord): PlatformFact[] {
    return [
      {
        kind: "team.created",
        subject: { type: "team", id: record.id },
        actor: record.createdBy,
        payload: { key: record.key, isDefault: record.isDefault },
        message: `Team created — ${record.name} (${record.key})`,
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
  assertDeletable(remainingTeams: number, openIssues: number): void {
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
          payload: { member: subject, key: this.record.key },
          message: `${subject} joined ${this.record.name}`,
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
          payload: { member: subject, key: this.record.key },
          message: `${subject} left ${this.record.name}`,
        },
      ],
    };
  }
}
