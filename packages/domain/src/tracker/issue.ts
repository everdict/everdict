import type {
  IssueGithub,
  IssueGithubComment,
  IssueGithubSync,
  IssueLink,
  IssueLinkType,
  IssueRecord,
  IssueResolution,
  IssueStatus,
  IssueStatusCause,
  PlatformFact,
} from "@everdict/contracts";
import { BadRequestError, ConflictError, ISSUE_GITHUB_COMMENT_LIMIT, NotFoundError } from "@everdict/contracts";
import { appendHistory } from "./history.js";

// The Issue aggregate — the tracker's unit of intent (docs/tracker.md). Transitions return {patch, facts} (E0,
// the same shape as Run/ScorecardBatch/Approval): the facts are born where the legality of the move is decided,
// and the store persists both in one transaction. Transitions must never be spread — always use .patch.
export interface IssueTransition {
  patch: Partial<IssueRecord>;
  facts: PlatformFact[];
}

export interface NewIssueLinkInput {
  type: IssueLinkType;
  id: string;
  version?: string;
  note?: string;
}

export interface NewIssueInput {
  id: string;
  tenant: string;
  title: string;
  description?: string;
  // Import maps a remote state onto our vocabulary (open → todo, closed → done); a member-filed issue starts in
  // the backlog unless they said otherwise.
  status?: IssueStatus;
  projectId?: string;
  assignee?: string;
  labels?: string[];
  links?: NewIssueLinkInput[];
  resolution?: IssueResolution;
  github?: IssueGithub;
  createdBy: string;
  origin?: { agentId?: string; conversationId?: string };
  now: string;
}

export interface IssueEditInput {
  title?: string;
  description?: string | null;
  labels?: string[];
  assignee?: string | null;
  projectId?: string | null;
}

export interface IssueStatusChangeOptions {
  cause?: IssueStatusCause;
  scorecardId?: string;
  note?: string;
}

export interface IssueReopenInput {
  // Default "todo" (a member picking work back up). The regression watch passes "regressed", which reads as an
  // alarm in every list instead of quietly looking like fresh work.
  to?: IssueStatus;
  cause: IssueStatusCause;
  scorecardId?: string;
  note?: string;
}

// OPEN = not done and not cancelled. `regressed` is deliberately open: a resolution that stopped holding is
// unfinished work, and the initiative readiness must treat it exactly like an unstarted issue.
export function isOpenIssueStatus(status: IssueStatus): boolean {
  return status !== "done" && status !== "cancelled";
}

function isTerminal(status: IssueStatus): boolean {
  return status === "done" || status === "cancelled";
}

export class Issue {
  private constructor(private readonly record: IssueRecord) {}

  static from(record: IssueRecord): Issue {
    return new Issue(record);
  }

  // The only place an issue record literal is assembled — import and manual filing share it, so a GitHub copy
  // and a hand-written issue are the same shape from birth.
  static newIssue(input: NewIssueInput): IssueRecord {
    const status = input.status ?? "backlog";
    return {
      id: input.id,
      tenant: input.tenant,
      title: input.title,
      ...(input.description !== undefined ? { description: input.description } : {}),
      status,
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      ...(input.assignee !== undefined ? { assignee: input.assignee } : {}),
      labels: input.labels ?? [],
      links: (input.links ?? []).map((link) => ({
        type: link.type,
        id: link.id,
        ...(link.version !== undefined ? { version: link.version } : {}),
        ...(link.note !== undefined ? { note: link.note } : {}),
        addedBy: input.createdBy,
        addedAt: input.now,
      })),
      ...(input.resolution !== undefined ? { resolution: input.resolution } : {}),
      ...(input.github !== undefined ? { github: input.github } : {}),
      history: [
        {
          at: input.now,
          by: input.createdBy,
          event: input.github !== undefined ? "github_imported" : "created",
          detail: {
            status,
            ...(input.github !== undefined ? { repository: input.github.repository, number: input.github.number } : {}),
          },
        },
      ],
      createdBy: input.createdBy,
      ...(input.origin !== undefined ? { origin: input.origin } : {}),
      createdAt: input.now,
      updatedAt: input.now,
    };
  }

  static creationFacts(record: IssueRecord): PlatformFact[] {
    return [
      {
        kind: "issue.created",
        subject: { type: "issue", id: record.id },
        actor: record.createdBy,
        payload: {
          status: record.status,
          source: record.github !== undefined ? "github" : "manual",
          ...(record.projectId !== undefined ? { projectId: record.projectId } : {}),
          ...(record.github !== undefined
            ? { repository: record.github.repository, number: record.github.number }
            : {}),
        },
        message: `Issue filed — ${record.title}`,
      },
    ];
  }

  isOpen(): boolean {
    return isOpenIssueStatus(this.record.status);
  }

  get status(): IssueStatus {
    return this.record.status;
  }

  get github(): IssueGithub | undefined {
    return this.record.github;
  }

  // Content editing — no facts. A retitled issue is not lifecycle news; the history entry is the audit trail.
  // `null` clears an optional field (unassign, detach from a project); `undefined` leaves it alone.
  update(fields: IssueEditInput, by: string, now: string): IssueTransition {
    const changed: string[] = [];
    const patch: Partial<IssueRecord> = {};
    if (fields.title !== undefined && fields.title !== this.record.title) {
      patch.title = fields.title;
      changed.push("title");
    }
    if (fields.description !== undefined) {
      const next = fields.description === null ? undefined : fields.description;
      if (next !== this.record.description) {
        patch.description = next;
        changed.push("description");
      }
    }
    if (fields.labels !== undefined) {
      patch.labels = fields.labels;
      changed.push("labels");
    }
    if (fields.assignee !== undefined) {
      const next = fields.assignee === null ? undefined : fields.assignee;
      if (next !== this.record.assignee) {
        patch.assignee = next;
        changed.push("assignee");
      }
    }
    if (fields.projectId !== undefined) {
      const next = fields.projectId === null ? undefined : fields.projectId;
      if (next !== this.record.projectId) {
        patch.projectId = next;
        changed.push("project");
      }
    }
    if (changed.length === 0) throw new BadRequestError("BAD_REQUEST", { issue: this.record.id }, "Nothing to update.");
    patch.history = appendHistory(this.record.history, { at: now, by, event: "updated", detail: { changed } });
    patch.updatedAt = now;
    return { patch, facts: [] };
  }

  // Ordinary workflow movement between OPEN states, plus cancellation. Reaching `done` goes through resolve()
  // (a closed issue must say what closed it) and `regressed` through reopen() (it only means anything as the
  // fall from a resolution).
  setStatus(to: IssueStatus, by: string, now: string, options: IssueStatusChangeOptions = {}): IssueTransition {
    if (to === "done")
      throw new BadRequestError(
        "BAD_REQUEST",
        { issue: this.record.id },
        "Closing an issue records how it was evaluated — resolve it instead of setting the status directly.",
      );
    if (to === "regressed")
      throw new BadRequestError(
        "BAD_REQUEST",
        { issue: this.record.id },
        "An issue can only regress from a resolution — reopen a done issue as regressed instead.",
      );
    if (to === this.record.status)
      throw new ConflictError(
        "CONFLICT",
        { issue: this.record.id, status: this.record.status },
        `Issue is already ${this.record.status}.`,
      );
    if (isTerminal(this.record.status))
      throw new ConflictError(
        "CONFLICT",
        { issue: this.record.id, status: this.record.status },
        `Issue is ${this.record.status} — reopen it before moving it.`,
      );
    return this.statusTransition(to, by, now, options, "status_changed");
  }

  // → done, with the evidence. `resolution.scorecardId` is what makes "how was it evaluated and closed"
  // answerable, and it becomes the baseline the regression watch compares later runs against.
  resolve(
    resolution: { scorecardId?: string; note?: string },
    by: string,
    now: string,
    cause: IssueStatusCause = "manual",
  ): IssueTransition {
    if (!this.isOpen())
      throw new ConflictError(
        "CONFLICT",
        { issue: this.record.id, status: this.record.status },
        `Issue is already ${this.record.status}.`,
      );
    const settled: IssueResolution = {
      ...(resolution.scorecardId !== undefined ? { scorecardId: resolution.scorecardId } : {}),
      ...(resolution.note !== undefined ? { note: resolution.note } : {}),
      by,
      at: now,
    };
    const transition = this.statusTransition(
      "done",
      by,
      now,
      { cause, ...(resolution.scorecardId !== undefined ? { scorecardId: resolution.scorecardId } : {}) },
      "resolved",
    );
    return { patch: { ...transition.patch, resolution: settled }, facts: transition.facts };
  }

  // Terminal → open again. The prior `resolution` is deliberately KEPT: a regressed issue must remember the
  // scorecard it fell from, and a manually reopened one keeps the record of how it was closed last time.
  reopen(input: IssueReopenInput, by: string, now: string): IssueTransition {
    if (!isTerminal(this.record.status))
      throw new ConflictError(
        "CONFLICT",
        { issue: this.record.id, status: this.record.status },
        `Issue is ${this.record.status} — only a done or cancelled issue can be reopened.`,
      );
    const to = input.to ?? "todo";
    if (!isOpenIssueStatus(to))
      throw new BadRequestError(
        "BAD_REQUEST",
        { issue: this.record.id, status: to },
        "Reopen requires an open status.",
      );
    if (to === "regressed" && this.record.status !== "done")
      throw new ConflictError(
        "CONFLICT",
        { issue: this.record.id, status: this.record.status },
        "Only a resolved issue can regress.",
      );
    return this.statusTransition(
      to,
      by,
      now,
      {
        cause: input.cause,
        ...(input.scorecardId !== undefined ? { scorecardId: input.scorecardId } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
      },
      "reopened",
    );
  }

  link(input: NewIssueLinkInput, by: string, now: string): IssueTransition {
    if (this.record.links.some((existing) => existing.type === input.type && existing.id === input.id))
      throw new ConflictError(
        "CONFLICT",
        { issue: this.record.id, type: input.type, id: input.id },
        `${input.type} ${input.id} is already linked to this issue.`,
      );
    const link: IssueLink = {
      type: input.type,
      id: input.id,
      ...(input.version !== undefined ? { version: input.version } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      addedBy: by,
      addedAt: now,
    };
    return {
      patch: {
        links: [...this.record.links, link],
        history: appendHistory(this.record.history, {
          at: now,
          by,
          event: "linked",
          detail: { type: link.type, id: link.id, ...(link.version !== undefined ? { version: link.version } : {}) },
        }),
        updatedAt: now,
      },
      facts: [
        {
          kind: "issue.linked",
          subject: { type: "issue", id: this.record.id },
          actor: by,
          payload: {
            linkType: link.type,
            linkId: link.id,
            ...(link.version !== undefined ? { version: link.version } : {}),
          },
          message: `Issue linked to ${link.type} ${link.id} — ${this.record.title}`,
        },
      ],
    };
  }

  unlink(type: IssueLinkType, id: string, by: string, now: string): IssueTransition {
    const remaining = this.record.links.filter((link) => !(link.type === type && link.id === id));
    if (remaining.length === this.record.links.length)
      throw new NotFoundError(
        "NOT_FOUND",
        { issue: this.record.id, type, id },
        `${type} ${id} is not linked to this issue.`,
      );
    return {
      patch: {
        links: remaining,
        history: appendHistory(this.record.history, { at: now, by, event: "unlinked", detail: { type, id } }),
        updatedAt: now,
      },
      facts: [],
    };
  }

  // --- GitHub copy seams (P1) ---
  // All of these patch FIELDS only. A remote open/closed change reaches our status through resolve()/reopen(),
  // so a sync-driven close emits the same fact a member's close does and the history reads the same.

  setGithubSync(sync: IssueGithubSync, by: string, now: string): IssueTransition {
    const github = this.requireGithub();
    return {
      patch: { github: { ...github, sync }, updatedAt: now },
      facts: [],
    };
  }

  detachGithub(by: string, now: string): IssueTransition {
    const github = this.requireGithub();
    return {
      patch: {
        github: undefined,
        history: appendHistory(this.record.history, {
          at: now,
          by,
          event: "updated",
          detail: { changed: ["github"], detached: `${github.repository}#${github.number}` },
        }),
        updatedAt: now,
      },
      facts: [],
    };
  }

  // Remote-owned fields land verbatim (GitHub is the source of record for title/body/labels/comments) and
  // `syncedAt` records the REMOTE clock reading — the watermark that both skips unchanged issues and swallows
  // the echo of our own push.
  applyGithubPull(
    remote: {
      title: string;
      description?: string;
      labels: string[];
      state: "open" | "closed";
      url: string;
      updatedAt: string;
      comments: IssueGithubComment[];
    },
    by: string,
    now: string,
  ): IssueTransition {
    const github = this.requireGithub();
    const changed: string[] = [];
    if (remote.title !== this.record.title) changed.push("title");
    if (remote.description !== this.record.description) changed.push("description");
    if (remote.labels.join(" ") !== this.record.labels.join(" ")) changed.push("labels");
    if (remote.state !== github.state) changed.push("state");
    // lastError is dropped by omission — a successful pull clears whatever failed before it.
    const { lastError: _cleared, ...rest } = github;
    const nextGithub: IssueGithub = {
      ...rest,
      url: remote.url,
      state: remote.state,
      syncedAt: remote.updatedAt,
      comments: remote.comments.slice(-ISSUE_GITHUB_COMMENT_LIMIT),
    };
    return {
      patch: {
        title: remote.title,
        description: remote.description,
        labels: remote.labels,
        github: nextGithub,
        history: appendHistory(this.record.history, {
          at: now,
          by,
          event: "github_pulled",
          detail: { changed, remoteState: remote.state, remoteUpdatedAt: remote.updatedAt },
        }),
        updatedAt: now,
      },
      facts: [],
    };
  }

  // Best-effort by contract: the local transition is already committed, so a push outcome only ever annotates.
  recordGithubPush(
    outcome: { ok: true; state: "open" | "closed" } | { ok: false; message: string },
    by: string,
    now: string,
  ): IssueTransition {
    const github = this.requireGithub();
    if (outcome.ok) {
      const { lastError: _cleared, ...rest } = github; // a successful push clears the previous failure
      const nextGithub: IssueGithub = { ...rest, state: outcome.state };
      return {
        patch: {
          github: nextGithub,
          history: appendHistory(this.record.history, {
            at: now,
            by,
            event: "github_pushed",
            detail: { state: outcome.state },
          }),
          updatedAt: now,
        },
        facts: [],
      };
    }
    return {
      patch: {
        github: { ...github, lastError: { at: now, op: "push", message: outcome.message } },
        history: appendHistory(this.record.history, {
          at: now,
          by,
          event: "github_push_failed",
          detail: { message: outcome.message },
        }),
        updatedAt: now,
      },
      facts: [],
    };
  }

  recordGithubPullFailure(message: string, now: string): IssueTransition {
    const github = this.requireGithub();
    return {
      patch: { github: { ...github, lastError: { at: now, op: "pull", message } }, updatedAt: now },
      facts: [],
    };
  }

  private requireGithub(): IssueGithub {
    const github = this.record.github;
    if (github === undefined)
      throw new BadRequestError(
        "BAD_REQUEST",
        { issue: this.record.id },
        "This issue is not linked to a GitHub issue.",
      );
    return github;
  }

  // The one place a status move becomes a patch + the folded `issue.status_changed` fact, so every path
  // (member, GitHub sync, regression watch) produces an identically-shaped fact that payload filters can match.
  private statusTransition(
    to: IssueStatus,
    by: string,
    now: string,
    options: IssueStatusChangeOptions,
    event: "status_changed" | "resolved" | "reopened",
  ): IssueTransition {
    const from = this.record.status;
    const cause: IssueStatusCause = options.cause ?? "manual";
    const detail = {
      from,
      to,
      cause,
      ...(options.scorecardId !== undefined ? { scorecardId: options.scorecardId } : {}),
      ...(options.note !== undefined ? { note: options.note } : {}),
    };
    return {
      patch: {
        status: to,
        history: appendHistory(this.record.history, { at: now, by, event, detail }),
        updatedAt: now,
      },
      facts: [
        {
          kind: "issue.status_changed",
          subject: { type: "issue", id: this.record.id },
          actor: by,
          payload: {
            from,
            to,
            cause,
            ...(this.record.projectId !== undefined ? { projectId: this.record.projectId } : {}),
            ...(options.scorecardId !== undefined ? { scorecardId: options.scorecardId } : {}),
          },
          message: `Issue ${from} → ${to} — ${this.record.title}`,
        },
      ],
    };
  }
}
