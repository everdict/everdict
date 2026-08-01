import {
  BadRequestError,
  ISSUE_GITHUB_COMMENT_LIMIT,
  type IssueGithub,
  type IssueGithubSync,
  type IssueRecord,
} from "@everdict/contracts";
import { Issue } from "@everdict/domain";
import type { GithubIssue, GithubRepoWriterFactory } from "../ports/github-repo-writer.js";
import type { IssueStore } from "../ports/issue-store.js";
import type { IssueActor, IssueService, IssueTeamAllocator } from "./issue-service.js";

// GitHub issue import + MANUAL two-way sync (docs/tracker.md). There is no webhook and no periodic sweep —
// everdict stays the client (docs/architecture/workspace-scoped-integrations.md), so a pull happens when a
// member presses Sync, and a push happens as the effect of a local transition they just made.
//
// Ownership split: GitHub owns title/description/labels/comments and the open↔closed state-of-record; everdict
// owns the status nuance (in_progress/in_review/regressed), projectId, links, resolution and assignee. Pull lets
// the remote win on GitHub-owned fields; push writes state + an explanatory comment. No field-level merge.

// The token half of the workspace GitHub App, narrowed to what sync needs (injecting the whole service would
// drag install/callback/repo-listing into this collaborator's surface for no reason).
export interface GithubRepositoryTokenSource {
  tokenForRepository(
    workspace: string,
    repository: string,
    permissions: Record<string, string>,
    host?: string,
  ): Promise<{ token: string; host?: string }>;
}

export interface ImportGithubIssuesInput {
  // Which team the imported copies land in. Absent = the workspace default, same as a hand-filed issue.
  teamId?: string;
  repository: string;
  host?: string;
  numbers: number[];
  projectId?: string;
  // Default: pull on (a copy that never refreshes is a stale copy), push OFF — closing someone else's GitHub
  // issue is not a side effect anyone should get by surprise.
  sync?: IssueGithubSync;
}

export interface ImportGithubIssuesResult {
  created: IssueRecord[];
  skipped: Array<{ number: number; reason: "already_imported" | "pull_request" }>;
}

export interface SyncOutcome {
  id: string;
  number: number;
  changed: boolean;
  error?: string;
}

export interface GithubIssueSyncDeps {
  store: IssueStore;
  // Transitions go back through the service so a sync-driven close emits the SAME fact a member's close does.
  issues: IssueService;
  // Same collaborator IssueService uses — an imported copy is numbered by the team it lands in.
  teams: IssueTeamAllocator;
  tokens: GithubRepositoryTokenSource;
  writers: GithubRepoWriterFactory;
  // Public web base URL — lets a push comment link back to the everdict issue. Absent = the comment omits the link.
  webBaseUrl?: string;
  now?: () => string;
}

const DEFAULT_SYNC: IssueGithubSync = { pull: true, push: false };
const LIST_PER_PAGE = 100;
const LIST_MAX_PAGES = 5;
// A minute of slack on the incremental watermark: `since` is compared against GitHub's own clock, and an update
// landing in the same second as our last read would otherwise be skipped forever.
const SINCE_SKEW_MS = 60_000;

function githubOf(record: IssueRecord): IssueGithub {
  const github = record.github;
  if (github === undefined)
    throw new BadRequestError("BAD_REQUEST", { issue: record.id }, "This issue is not linked to a GitHub issue.");
  return github;
}

export class GithubIssueSync {
  private readonly now: () => string;

  constructor(private readonly deps: GithubIssueSyncDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  // What can still be imported: the repo's issues minus pull requests minus the ones this workspace already has.
  async importCandidates(
    tenant: string,
    input: { repository: string; host?: string; state?: string },
  ): Promise<GithubIssue[]> {
    const writer = await this.writerFor(tenant, input.repository, { issues: "read" }, input.host);
    const remote = await writer.listIssues(input.repository, {
      ...(input.state !== undefined ? { state: input.state } : {}),
      perPage: LIST_PER_PAGE,
      maxPages: LIST_MAX_PAGES,
    });
    const candidates: GithubIssue[] = [];
    for (const issue of remote) {
      if (issue.isPullRequest) continue;
      const existing = await this.deps.store.getByGithub(tenant, input.repository, issue.number, input.host);
      if (existing) continue;
      candidates.push(issue);
    }
    return candidates;
  }

  // Import is idempotent by the remote identity: re-importing a number the workspace already holds is a skip,
  // not a duplicate, so a member can re-run the flow after a partial failure.
  async import(tenant: string, input: ImportGithubIssuesInput, actor: IssueActor): Promise<ImportGithubIssuesResult> {
    const writer = await this.writerFor(tenant, input.repository, { issues: "read" }, input.host);
    const sync = input.sync ?? DEFAULT_SYNC;
    const created: IssueRecord[] = [];
    const skipped: ImportGithubIssuesResult["skipped"] = [];
    for (const number of input.numbers) {
      if (await this.deps.store.getByGithub(tenant, input.repository, number, input.host)) {
        skipped.push({ number, reason: "already_imported" });
        continue;
      }
      const remote = await writer.getIssue(input.repository, number);
      if (remote.isPullRequest) {
        skipped.push({ number, reason: "pull_request" });
        continue;
      }
      const comments = await writer
        .listIssueComments(input.repository, number, { maxComments: ISSUE_GITHUB_COMMENT_LIMIT })
        .catch(() => []); // the thread is context, never a reason to fail the import
      const github: IssueGithub = {
        ...(input.host !== undefined ? { host: input.host } : {}),
        repository: input.repository,
        number: remote.number,
        url: remote.url,
        state: remote.state === "closed" ? "closed" : "open",
        syncedAt: remote.updatedAt,
        sync,
        comments,
      };
      const now = this.now();
      // Imported copies get an identifier from the same allocator a hand-filed issue uses, so a GitHub copy is
      // a first-class issue from birth — ENG-12 regardless of where it came from.
      const { team, grant } = await this.deps.teams.allocateForIssue(tenant, input.teamId, actor.subject);
      const record = Issue.newIssue({
        id: crypto.randomUUID(),
        tenant,
        teamId: team.id,
        number: grant.number,
        identifier: grant.identifier,
        title: remote.title,
        ...(remote.body !== undefined ? { description: remote.body } : {}),
        // A closed GitHub issue lands as done WITHOUT a scorecard — it was resolved elsewhere, and claiming
        // evidence we do not have would poison every regression comparison downstream.
        status: remote.state === "closed" ? "done" : "todo",
        ...(remote.state === "closed"
          ? { resolution: { note: "Closed on GitHub before import.", by: actor.subject, at: now } }
          : {}),
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
        labels: remote.labels,
        github,
        createdBy: actor.subject,
        ...(actor.agent !== undefined ? { origin: actor.agent } : {}),
        now,
      });
      created.push(await this.deps.issues.createImported(record, actor.agent));
    }
    return { created, skipped };
  }

  async pullIssue(tenant: string, id: string, actor: IssueActor): Promise<IssueRecord> {
    const record = await this.deps.issues.get(tenant, id);
    const github = githubOf(record);
    const writer = await this.writerFor(tenant, github.repository, { issues: "read" }, github.host);
    const remote = await writer.getIssue(github.repository, github.number);
    const comments = await writer
      .listIssueComments(github.repository, github.number, { maxComments: ISSUE_GITHUB_COMMENT_LIMIT })
      .catch(() => []);
    return (await this.applyRemote(tenant, record, remote, comments, actor)).record;
  }

  // The manual bulk pull: ONE incremental list call for the whole repo, then per-issue apply. A failure on one
  // issue is recorded on that issue and the batch continues — a single broken row must not stall the rest.
  async pullRepository(
    tenant: string,
    input: { repository: string; host?: string },
    actor: IssueActor,
  ): Promise<SyncOutcome[]> {
    const tracked = await this.deps.store.list(tenant, {
      githubRepository: input.repository,
      syncPull: true,
    });
    const mine = tracked.filter((record) => record.github?.host === input.host);
    if (mine.length === 0) return [];
    const writer = await this.writerFor(tenant, input.repository, { issues: "read" }, input.host);
    const remote = await writer.listIssues(input.repository, {
      state: "all",
      perPage: LIST_PER_PAGE,
      maxPages: LIST_MAX_PAGES,
      ...(this.watermark(mine) !== undefined ? { since: this.watermark(mine) } : {}),
    });
    const byNumber = new Map(remote.map((issue) => [issue.number, issue]));
    const outcomes: SyncOutcome[] = [];
    for (const record of mine) {
      const github = githubOf(record);
      const found = byNumber.get(github.number);
      // Absent from an incremental page = unchanged since the watermark. That is the common case, and skipping
      // it is what keeps a manual sync of a busy repo cheap.
      if (!found) {
        outcomes.push({ id: record.id, number: github.number, changed: false });
        continue;
      }
      try {
        const comments = await writer
          .listIssueComments(github.repository, github.number, { maxComments: ISSUE_GITHUB_COMMENT_LIMIT })
          .catch(() => []);
        const applied = await this.applyRemote(tenant, record, found, comments, actor);
        outcomes.push({ id: record.id, number: github.number, changed: applied.changed });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.recordPullFailure(tenant, record, message);
        outcomes.push({ id: record.id, number: github.number, changed: false, error: message });
      }
    }
    return outcomes;
  }

  async setSync(tenant: string, id: string, sync: IssueGithubSync, actor: IssueActor): Promise<IssueRecord> {
    return this.deps.issues.setGithubSync(tenant, id, sync, actor);
  }

  // The IssueGithubPusher half, invoked fire-and-forget from IssueService.applyTransition. The local transition
  // is already committed by the time this runs, so every outcome — success or failure — only annotates.
  async pushStatus(record: IssueRecord, actor: IssueActor): Promise<void> {
    const github = record.github;
    if (github === undefined || !github.sync.push) return;
    const closed = record.status === "done" || record.status === "cancelled";
    const nextState = closed ? "closed" : "open";
    try {
      const writer = await this.writerFor(record.tenant, github.repository, { issues: "write" }, github.host);
      if (github.state !== nextState) await writer.updateIssue(github.repository, github.number, { state: nextState });
      await writer.createIssueComment(github.repository, github.number, this.pushComment(record));
      await this.applyTransitionPatch(
        record,
        Issue.from(record).recordGithubPush({ ok: true, state: nextState }, actor.subject, this.now()),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.applyTransitionPatch(
        record,
        Issue.from(record).recordGithubPush({ ok: false, message }, actor.subject, this.now()),
      );
    }
  }

  // Remote-owned fields land verbatim, then the open↔closed reconciliation goes through the NORMAL transitions
  // so a sync-driven close is indistinguishable (in facts and history) from a member's close.
  // `changed` reports whether anything was actually applied — derived from the watermark decision, not from a
  // timestamp diff, so it stays truthful no matter the clock's resolution.
  private async applyRemote(
    tenant: string,
    record: IssueRecord,
    remote: GithubIssue,
    comments: IssueGithub["comments"],
    actor: IssueActor,
  ): Promise<{ record: IssueRecord; changed: boolean }> {
    const github = githubOf(record);
    // ECHO SUPPRESSION: our own push bumps the remote updated_at, and re-reading it must not look like news.
    // The watermark is GitHub's clock on both sides, so this comparison is skew-proof.
    if (github.syncedAt !== undefined && remote.updatedAt <= github.syncedAt) return { record, changed: false };

    const remoteState = remote.state === "closed" ? "closed" : "open";
    const pulled = await this.applyTransitionPatch(
      record,
      Issue.from(record).applyGithubPull(
        {
          title: remote.title,
          ...(remote.body !== undefined ? { description: remote.body } : {}),
          labels: remote.labels,
          state: remoteState,
          url: remote.url,
          updatedAt: remote.updatedAt,
          comments,
        },
        actor.subject,
        this.now(),
      ),
    );

    const localOpen = pulled.status !== "done" && pulled.status !== "cancelled";
    if (remoteState === "closed" && localOpen)
      return {
        record: await this.deps.issues.setStatus(
          tenant,
          pulled.id,
          { status: "done", resolution: { note: "Closed on GitHub." }, cause: "github_sync" },
          actor,
        ),
        changed: true,
      };
    if (remoteState === "open" && !localOpen)
      return {
        record: await this.deps.issues.setStatus(tenant, pulled.id, { status: "todo", cause: "github_sync" }, actor),
        changed: true,
      };
    return { record: pulled, changed: true };
  }

  private async recordPullFailure(tenant: string, record: IssueRecord, message: string): Promise<void> {
    await this.applyTransitionPatch(record, Issue.from(record).recordGithubPullFailure(message, this.now()));
  }

  // These patches carry no facts by construction (they are field annotations, not lifecycle news), so they go
  // straight to the store rather than through the service's fact-stamping path.
  private async applyTransitionPatch(
    record: IssueRecord,
    transition: { patch: Partial<IssueRecord> },
  ): Promise<IssueRecord> {
    const updated = await this.deps.store.update(record.tenant, record.id, transition.patch);
    return updated ?? record;
  }

  // The oldest watermark across the tracked issues — a single `since` that cannot miss an update for any of them.
  private watermark(records: IssueRecord[]): string | undefined {
    const stamps = records.map((r) => r.github?.syncedAt).filter((s): s is string => s !== undefined);
    if (stamps.length !== records.length || stamps.length === 0) return undefined; // any un-watermarked issue = full read
    const oldest = stamps.reduce((a, b) => (a <= b ? a : b));
    return new Date(new Date(oldest).getTime() - SINCE_SKEW_MS).toISOString();
  }

  private pushComment(record: IssueRecord): string {
    const link = this.deps.webBaseUrl
      ? `\n\n[View in everdict](${this.deps.webBaseUrl.replace(/\/$/, "")}/${record.tenant}/issues/${record.id})`
      : "";
    if (record.status === "regressed")
      return `Reopened in everdict — this issue **regressed**: a later evaluation fell below the scorecard that closed it.${link}`;
    if (record.status === "done") {
      const note = record.resolution?.note ? `\n\n${record.resolution.note}` : "";
      const evidence = record.resolution?.scorecardId
        ? `\n\nEvidence: scorecard \`${record.resolution.scorecardId}\``
        : "";
      return `Resolved in everdict.${note}${evidence}${link}`;
    }
    if (record.status === "cancelled") return `Cancelled in everdict.${link}`;
    return `Reopened in everdict (now \`${record.status}\`).${link}`;
  }

  private async writerFor(tenant: string, repository: string, permissions: Record<string, string>, host?: string) {
    const minted = await this.deps.tokens.tokenForRepository(tenant, repository, permissions, host);
    return this.deps.writers.for(minted.token, minted.host);
  }
}
