import {
  BadRequestError,
  type CommentAgentStatus,
  type CommentRecord,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "@everdict/contracts";
import type { CommentStore } from "../ports/comment-store.js";
import type { DiscussionTurnRunner } from "../ports/discussion-turn-runner.js";
import type { PlatformEventEmitter } from "../ports/platform-event-emitter.js";

// Comment service — collaborative discussion on resources (harness/dataset/scorecard/view/schedule/job/runtime) + single-level replies.
// Shared by HTTP routes and MCP tools (BFF↔MCP parity). authZ: read=comments:read, write=comments:write, delete=author-or-admin.
// The tracker's three kinds are commentable for the same reason datasets are: an issue is where a team argues
// about how something was evaluated, and threading that discussion anywhere else splits the record.
export const COMMENT_RESOURCE_TYPES = [
  "dataset",
  "harness",
  "scorecard",
  "view",
  "schedule",
  "run",
  "runtime",
  "issue",
  // A cycle's retro is a discussion about that iteration — threading it anywhere else splits the record from
  // the numbers it is about.
  "cycle",
  "project",
  "initiative",
] as const;
export type CommentResourceType = (typeof COMMENT_RESOURCE_TYPES)[number];

const MAX_BODY = 10_000; // cap the body (plenty for rich discussion, blocks DoS)

// Reserved author subject for agent-authored comments (@everdict answers). Never a real member subject
// (Keycloak subjects are opaque UUIDs; the "everdict:" prefix is ours).
export const COMMENT_AGENT_AUTHOR = "everdict:agent";

// WHO is really speaking, when the caller is an agent. An agent reaches the control plane with the MEMBER'S OWN
// credential (apps/agent is a token courier), so the authenticated subject alone credited a member for words they
// never wrote — an agent answering on an issue read as the operator's own comment. A caller that declares an agent
// speaks as Everdict instead; the member stays only where they belong, as the authority the call was made under.
// This is the same provenance the workspace filesystem's revision ledger already takes from the request headers
// (`fs-actor.ts`) — attribution, not privilege: the write is authorized by the member's token either way, so a
// forged declaration can only mislabel the caller's OWN comment, never widen what they may do.
export interface CommentAgentAttribution {
  // The agent conversation this comment came out of — the thread's "view details" target, and the only way back
  // from a posted answer to the reasoning that produced it.
  conversationId?: string;
}

export interface CommentServiceDeps {
  store: CommentStore;
  // Platform-event emit seam (agent-automation A1) — comment.created facts. Agent-authored comments are
  // deliberately NOT emitted (an agent watching comment.created must never wake on its own answers). emit
  // never throws (best-effort).
  events?: PlatformEventEmitter;
  // Mention notification hook — called when a comment contains an @-mention (recipients excluding the author). Silently skipped if unset.
  // Wired in main.ts to NotificationService.notifyMention (including actor-name resolution).
  notifyMention?: (input: { tenant: string; comment: CommentRecord; recipients: string[] }) => Promise<void>;
  // Discussion-agent bridge (@everdict in the thread) — unset = askAgent is skipped (the member comment still posts).
  discussionRunner?: DiscussionTurnRunner;
  // subject → display name for the thread snapshot the agent reads. Unset → raw subjects.
  memberNames?: (tenant: string) => Promise<Record<string, string>>;
  // Tell the asker the agent's answer landed/failed (they may have left the page). Best-effort; unset = no ping.
  notifyAgentAnswer?: (input: {
    tenant: string;
    recipient: string;
    resourceType: string;
    resourceId: string;
    commentId: string;
    preview: string;
    ok: boolean;
  }) => Promise<void>;
  // Tell the asker the discussion turn PARKED on a write-tool approval (HITL, notifications.md N8) — the turn
  // cannot continue until somebody answers, and the asker may have left the page the ApprovalStrip renders on.
  // Best-effort; unset = no ping.
  notifyApprovalRequested?: (input: {
    tenant: string;
    recipient: string;
    resourceType: string;
    resourceId: string;
    commentId: string;
    tool?: string;
  }) => Promise<void>;
  // The park was decided (the status left awaiting_approval) — delete the ask's bell row (N8): a decided
  // approval ask stops being true, so it is cleared rather than left as misleading history. Best-effort.
  clearApprovalRequest?: (input: { tenant: string; commentId: string }) => Promise<void>;
  newId?: () => string;
  now?: () => string;
}

export class CommentService {
  private readonly newId: () => string;
  private readonly now: () => string;

  constructor(private readonly deps: CommentServiceDeps) {
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  private assertType(resourceType: string): void {
    if (!(COMMENT_RESOURCE_TYPES as readonly string[]).includes(resourceType)) {
      throw new BadRequestError("BAD_REQUEST", { resourceType }, `Unsupported comment target: ${resourceType}`);
    }
  }

  // A resource's comments (oldest→newest, timeline order). Workspace-scoped.
  list(tenant: string, resourceType: string, resourceId: string): Promise<CommentRecord[]> {
    this.assertType(resourceType);
    return this.deps.store.list(tenant, resourceType, resourceId);
  }

  // Post a comment. Empty/overlong body → 400. author = the authenticated subject. mentions = @-mentioned subjects
  // (notified, excluding whoever is speaking).
  // With parentId it's a reply — only allowed on a "top-level" comment of the same resource (single-level thread; 400 if the parent is already a reply).
  // With askAgent (@everdict mentioned) the thread is handed to the discussion agent: a placeholder agent comment is
  // created in the same thread and the turn is fired (409 while a previous ask on this resource is still working).
  // With agent, the comment is Everdict's own — see CommentAgentAttribution.
  async create(input: {
    tenant: string;
    resourceType: string;
    resourceId: string;
    author: string;
    body: string;
    parentId?: string;
    mentions?: string[];
    askAgent?: boolean;
    agent?: CommentAgentAttribution;
  }): Promise<CommentRecord> {
    this.assertType(input.resourceType);
    const body = input.body.trim();
    if (body.length === 0) throw new BadRequestError("BAD_REQUEST", undefined, "Comment content is required.");
    if (body.length > MAX_BODY)
      throw new BadRequestError("BAD_REQUEST", { max: MAX_BODY }, `Comment must be at most ${MAX_BODY} characters.`);
    // Who the thread will show as the author. An agent's comment is Everdict's; a member's is their own.
    const agent = input.agent;
    const author = agent ? COMMENT_AGENT_AUTHOR : input.author;
    // An agent handing a thread to the discussion agent would trigger a turn on its own comment, and that answer
    // would sit in the snapshot of the next one — the echo the agent-authored fact suppression exists to prevent.
    // Refused rather than silently dropped, so the caller learns why nothing was answered.
    if (input.askAgent && agent)
      throw new BadRequestError(
        "BAD_REQUEST",
        undefined,
        "An agent cannot hand a thread to the discussion agent — it would be answering its own comment.",
      );
    if (input.parentId) {
      const parent = await this.deps.store.get(input.tenant, input.parentId);
      if (!parent || parent.resourceType !== input.resourceType || parent.resourceId !== input.resourceId)
        throw new BadRequestError("BAD_REQUEST", { parentId: input.parentId }, "Parent comment not found.");
      if (parent.parentId)
        throw new BadRequestError("BAD_REQUEST", { parentId: input.parentId }, "Cannot reply to a reply.");
    }
    // Busy-guard BEFORE anything persists: one agent turn per thread at a time (also serializes the shared session).
    const thread = input.askAgent ? await this.deps.store.list(input.tenant, input.resourceType, input.resourceId) : [];
    if (input.askAgent && this.deps.discussionRunner) {
      const busy = thread.some(
        (c) => c.authorKind === "agent" && (c.agentStatus === "running" || c.agentStatus === "awaiting_approval"),
      );
      if (busy)
        throw new ConflictError(
          "CONFLICT",
          undefined,
          "The agent is already working on this discussion — wait for it to finish.",
        );
    }
    const ts = this.now();
    const record: CommentRecord = {
      id: this.newId(),
      tenant: input.tenant,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      ...(input.parentId ? { parentId: input.parentId } : {}),
      author,
      body,
      // An agent posting through a tool already HAS its answer, so unlike a @everdict placeholder there is no
      // lifecycle to drive: the comment is born `complete`, the status the thread renders markdown from.
      ...(agent
        ? {
            authorKind: "agent" as const,
            agentStatus: "complete" as const,
            ...(agent.conversationId !== undefined ? { agentSessionId: agent.conversationId } : {}),
          }
        : {}),
      createdAt: ts,
      updatedAt: ts,
    };
    await this.deps.store.add(record);
    // Lifecycle FACT (agent-automation A2) — agent-authored comments are excluded so a watching agent never
    // wakes on its own (or a peer agent's) answers: the echo would loop.
    if (author !== COMMENT_AGENT_AUTHOR) {
      void this.deps.events?.emit({
        workspace: input.tenant,
        kind: "comment.created",
        subject: { type: input.resourceType, id: input.resourceId },
        actor: input.author,
        payload: {
          commentId: record.id,
          // What was said, first line's worth — a "comment created" fact with no words is unreadable in any
          // feed, and no feed reader can (or should) re-fetch the thread per row.
          excerpt: body.slice(0, 140),
          ...(record.parentId !== undefined ? { parentId: record.parentId } : {}),
        },
        message: `New comment on ${input.resourceType} ${input.resourceId}: ${body.slice(0, 140)}`,
      });
    }
    // Mention notifications — exclude the SPEAKER, dedupe. Not the authenticated subject: an agent tagging the
    // member it acted for is telling someone about a comment they did not write, so that ping must go out.
    // A notification failure doesn't affect the comment result (swallowed).
    const recipients = [...new Set(input.mentions ?? [])].filter((s) => s && s !== author);
    if (recipients.length > 0 && this.deps.notifyMention) {
      try {
        await this.deps.notifyMention({ tenant: input.tenant, comment: record, recipients });
      } catch {
        // Ignore notification failure (the comment is already saved).
      }
    }
    if (input.askAgent && this.deps.discussionRunner) await this.startAgentAnswer(record, [...thread, record]);
    return record;
  }

  // Create the placeholder agent comment in the trigger's thread and fire the detached discussion turn. The thread's
  // agent session is REUSED across asks (the newest agent comment's session id) so the agent keeps the discussion's
  // memory; the first ask mints a fresh id. A trigger failure marks the placeholder failed (never throws — the
  // member's comment is already posted).
  private async startAgentAnswer(trigger: CommentRecord, thread: CommentRecord[]): Promise<void> {
    const runner = this.deps.discussionRunner;
    if (!runner) return;
    const previous = [...thread].reverse().find((c) => c.authorKind === "agent" && c.agentSessionId);
    const sessionId = previous?.agentSessionId ?? this.newId();
    const ts = this.now();
    // The thread the answer belongs to: the trigger when it is top-level, else the trigger's own anchor (a reply
    // can never be a parent). The placeholder hangs here AND the turn is told it — see the port.
    const anchorId = trigger.parentId ?? trigger.id;
    const placeholder: CommentRecord = {
      id: this.newId(),
      tenant: trigger.tenant,
      resourceType: trigger.resourceType,
      resourceId: trigger.resourceId,
      parentId: anchorId,
      author: COMMENT_AGENT_AUTHOR,
      body: "", // filled with the final markdown answer on complete
      authorKind: "agent",
      agentStatus: "running",
      agentActivity: "thinking",
      agentSessionId: sessionId,
      agentAskedBy: trigger.author, // the completion notification's recipient (survives restarts)
      createdAt: ts,
      updatedAt: ts,
    };
    await this.deps.store.add(placeholder);
    const empty: Record<string, string> = {};
    const names = await (this.deps.memberNames?.(trigger.tenant).catch(() => empty) ?? Promise.resolve(empty));
    try {
      await runner.run({
        tenant: trigger.tenant,
        askedBy: trigger.author,
        resourceType: trigger.resourceType,
        resourceId: trigger.resourceId,
        commentId: placeholder.id,
        // The thread the turn is answering IN. The snapshot below is deliberately id-less (the agent reads people,
        // not rows), so this is the one comment id it gets, and the one it needs: a create_comment without it can
        // only be top-level, which is how an answer escapes its own discussion.
        anchorId,
        sessionId,
        // Snapshot for the agent: member comments + finished agent answers (skip empty/failed placeholders).
        thread: thread
          .filter((c) => c.authorKind !== "agent" || (c.agentStatus === "complete" && c.body.length > 0))
          .map((c) => ({
            author: c.author,
            authorName: c.authorKind === "agent" ? "Everdict" : (names[c.author] ?? c.author),
            body: c.body,
            at: c.createdAt,
          })),
      });
    } catch {
      // The agent service is unreachable / rejected the trigger — the placeholder must not stay "running" forever.
      await this.deps.store
        .update(trigger.tenant, placeholder.id, { agentStatus: "failed", agentActivity: null }, this.now())
        .catch(() => undefined);
    }
  }

  // Lifecycle callback for the agent's progress on its placeholder comment (the /internal/comment-activity route).
  // Only agent comments are mutable; terminal statuses clear the "doing now" line unless the patch sets one.
  async applyProgress(
    tenant: string,
    commentId: string,
    patch: { status?: CommentAgentStatus; activity?: string | null; body?: string },
  ): Promise<void> {
    const existing = await this.deps.store.get(tenant, commentId);
    if (!existing || existing.authorKind !== "agent")
      throw new NotFoundError("NOT_FOUND", { id: commentId }, "Agent comment not found.");
    const terminal = patch.status === "complete" || patch.status === "failed";
    await this.deps.store.update(
      tenant,
      commentId,
      {
        ...(patch.body !== undefined ? { body: patch.body } : {}),
        ...(patch.status !== undefined ? { agentStatus: patch.status } : {}),
        ...(patch.activity !== undefined ? { agentActivity: patch.activity } : terminal ? { agentActivity: null } : {}),
      },
      this.now(),
    );
    // ENTERING the approval park pings the asker (N8) — the turn is now waiting on a human, and nobody may be
    // on the page the ApprovalStrip renders on. Transition-guarded like the terminal ping below, so the turn's
    // repeated activity ticks while parked never re-ping; a second park in the same turn (approve → run →
    // park again) is a new decision and pings again. The parked tool rides the activity token (`tool:<name>`).
    if (
      patch.status === "awaiting_approval" &&
      existing.agentStatus !== "awaiting_approval" &&
      existing.agentAskedBy &&
      this.deps.notifyApprovalRequested
    ) {
      const tool = patch.activity?.startsWith("tool:") ? patch.activity.slice("tool:".length) : undefined;
      try {
        await this.deps.notifyApprovalRequested({
          tenant,
          recipient: existing.agentAskedBy,
          resourceType: existing.resourceType,
          resourceId: existing.resourceId,
          commentId,
          ...(tool !== undefined && tool.length > 0 ? { tool } : {}),
        });
      } catch {
        // Ignore notification failure (the lifecycle is already persisted).
      }
    }
    // Leaving the park (approved/denied/swept — the status moved OFF awaiting_approval) deletes the ask's
    // bell row: a decided ask is no longer true, and the freed id lets a later park in this thread ping again.
    if (
      existing.agentStatus === "awaiting_approval" &&
      patch.status !== undefined &&
      patch.status !== "awaiting_approval" &&
      this.deps.clearApprovalRequest
    ) {
      try {
        await this.deps.clearApprovalRequest({ tenant, commentId });
      } catch {
        // A stale bell row at worst — never the lifecycle's failure.
      }
    }
    // Reaching a terminal state pings the asker (they may have left the page while the turn ran). Best-effort —
    // a notification failure never fails the lifecycle write; re-reports of the same terminal state don't re-ping.
    if (terminal && existing.agentStatus !== patch.status && existing.agentAskedBy && this.deps.notifyAgentAnswer) {
      try {
        await this.deps.notifyAgentAnswer({
          tenant,
          recipient: existing.agentAskedBy,
          resourceType: existing.resourceType,
          resourceId: existing.resourceId,
          commentId,
          preview: patch.status === "complete" ? (patch.body ?? "") : "",
          ok: patch.status === "complete",
        });
      } catch {
        // Ignore notification failure (the lifecycle is already persisted).
      }
    }
  }

  // Sweep for stranded agent answers: the lifecycle is driven by the agent service's callbacks, which die with it
  // (a crash / severed detached turn) — a comment then shows "running"/"awaiting approval" forever. Anything non-terminal
  // that has not been touched for `staleMs` is dead (activity ticks land far more often; an approval park times out
  // and resumes within the discussion window) → mark failed and ping the asker. Returns how many were swept.
  async sweepStuckAgentAnswers(staleMs: number): Promise<number> {
    const cutoff = new Date(Date.parse(this.now()) - staleMs).toISOString();
    const stuck = await this.deps.store.listStuckAgentAnswers(cutoff);
    for (const comment of stuck) {
      await this.applyProgress(comment.tenant, comment.id, { status: "failed" });
    }
    return stuck.length;
  }

  // Delete — the author or a workspace admin only. Missing → 404, unauthorized → 403.
  async delete(input: { tenant: string; id: string; subject: string; isAdmin: boolean }): Promise<void> {
    const existing = await this.deps.store.get(input.tenant, input.id);
    if (!existing) throw new NotFoundError("NOT_FOUND", { id: input.id }, "Comment not found.");
    if (existing.author !== input.subject && !input.isAdmin) {
      throw new ForbiddenError("FORBIDDEN", { id: input.id }, "Only the author or an admin can delete a comment.");
    }
    await this.deps.store.remove(input.tenant, input.id);
  }
}
