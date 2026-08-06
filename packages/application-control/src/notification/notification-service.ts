import type { NotificationRecord, WorkspaceSettings } from "@everdict/contracts";
import { mattermostConnections } from "@everdict/domain";
import type { MattermostClient } from "../ports/mattermost-client.js";
import type { NotificationListOptions, NotificationStore } from "../ports/notification-store.js";
import type { EmitPlatformEventInput, PlatformEventEmitter } from "../ports/platform-event-emitter.js";

// Completion notifications (docs/architecture/notifications.md N5) — BOTH channels now ride the event log
// (event-plumbing E1, one log · N cursors): the personal feed via feed:runs/feed:scorecards, the Mattermost
// channel via mm:completions driving postChannelMessage below. This service keeps the feed store surface
// (bell reads/acks), the report fan-out, and the Mattermost transport itself.
// Notification failure never affects the run/scorecard result (fire-and-forget — the store is the source of truth).
export interface NotificationServiceDeps {
  settingsFor: (tenant: string) => Promise<WorkspaceSettings | undefined>;
  // Workspace Mattermost (bot token) — resolves each connection's botTokenSecretName from the workspace SecretStore.
  secretsFor?: (tenant: string) => Promise<Record<string, string>>;
  // Operator-configured Mattermost server URL (MATTERMOST_HOST env), shared across the deployment — the host is no
  // longer stored per workspace. If unset, channel posting is silently skipped (feed still writes).
  mattermostHost?: string;
  // Control-plane public base URL (API_PUBLIC_URL) — the interactive Rerun button posts back to
  // /integrations/mattermost/action, so it only attaches when Mattermost can actually reach us.
  apiPublicUrl?: string;
  feed?: NotificationStore; // personal notification feed — if unset, only the feed channel is silently skipped
  // Outbound Mattermost transport (adapter) — if unset, channel posting is silently skipped (feed still writes).
  mattermost?: MattermostClient;
  // Third channel: record the completion as a platform EVENT (durable log + agent push — agent-automation A1).
  // The agent service wakes the creator's watching teammates AND matches registry-agent triggers workspace-wide.
  // Unset → skipped. Best-effort like the other channels.
  events?: PlatformEventEmitter;
  newId?: () => string;
  now?: () => string;
}

// The narrow capability the mm:completions consumer needs — kept as an interface so the consumer's tests
// stay a two-line fake.
export interface ChannelPoster {
  postChannelMessage(tenant: string, message: string, rerun?: { dataset: string; harness: string }): Promise<void>;
}

// Where an approval ask parked (N8) — the two surfaces a HITL park can live on. The KEY is what identifies
// the row (clearing needs only that); notifying additionally carries the discussion's link coordinates.
export type ApprovalPlaceKey = { kind: "conversation"; sessionId: string } | { kind: "discussion"; commentId: string };
export type ApprovalPlace =
  | { kind: "conversation"; sessionId: string }
  | { kind: "discussion"; resourceType: string; resourceId: string; commentId: string };

// One live ask per session/comment (asks are sequential), so the place IS the row's identity: notify and
// clear derive the same id, and a re-notified park deduplicates in the store.
function approvalNotificationId(place: ApprovalPlaceKey): string {
  return place.kind === "conversation" ? `nf-approval-${place.sessionId}` : `nf-approval-${place.commentId}`;
}

export class NotificationService implements ChannelPoster {
  private readonly newId: () => string;
  private readonly nowIso: () => string;
  constructor(private readonly deps: NotificationServiceDeps) {
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.nowIso = deps.now ?? (() => new Date().toISOString());
  }

  // A scheduled analysis report was produced (analysis-studio V4) — called by the report-runner adapter after the
  // headless turn completes. Same three best-effort channels as a completion: feed + Mattermost + agent event.
  async notifyReport(
    tenant: string,
    input: {
      scheduleId: string;
      scheduleName: string;
      viewId: string;
      artifactId?: string;
      createdBy: string;
    },
  ): Promise<void> {
    await this.pushFeed({
      workspace: tenant,
      recipient: input.createdBy,
      kind: "report_completed",
      title: `Report ready — ${input.scheduleName}`,
      body: input.artifactId ? undefined : "The run produced no report artifact.",
      link: {
        resourceType: "view",
        resourceId: input.viewId,
        ...(input.artifactId !== undefined ? { artifactId: input.artifactId } : {}),
      },
    });
    await this.pushEvent({
      workspace: tenant,
      recipient: input.createdBy,
      actor: input.createdBy,
      kind: "report.completed",
      subject: { type: "view", id: input.viewId },
      payload: {
        scheduleId: input.scheduleId,
        // The schedule's name is what a feed row cites — the view id it links to is a uuid.
        name: input.scheduleName,
        ...(input.artifactId !== undefined ? { artifactId: input.artifactId } : {}),
      },
      message: `Scheduled report "${input.scheduleName}" is ready on view ${input.viewId}${input.artifactId ? ` (artifact ${input.artifactId})` : " (no artifact produced)"}.`,
    });
    // The Mattermost channel rides the report.completed fact above (the mm:completions cursor consumer) —
    // one log, N cursors; this path keeps only the personal feed + the fact.
  }

  // The channel-post capability the mm:completions cursor consumer drives (the ONLY Mattermost writer since
  // the re-base) — same fire-and-forget contract as the old direct path: a transport failure skips the post.
  async postChannelMessage(
    tenant: string,
    message: string,
    rerun?: { dataset: string; harness: string },
  ): Promise<void> {
    await this.post(tenant, message, rerun);
  }

  // --- Personal feed (bell inbox) — self-scoped (same as connections/runners), no role gate ---

  listFeed(recipient: string, workspace: string, opts?: NotificationListOptions): Promise<NotificationRecord[]> {
    return this.deps.feed?.list(recipient, workspace, opts) ?? Promise.resolve([]);
  }

  markFeedRead(recipient: string, workspace: string, ids: string[] | "all"): Promise<number> {
    return this.deps.feed?.markRead(recipient, workspace, ids, this.nowIso()) ?? Promise.resolve(0);
  }

  // Comment @mention — a personal feed notification to the mentioned user(s). The link points at that context (dataset comment, commentId anchor).
  // recipients = the mentioned subjects (the author themselves is excluded by the caller). Does not post to a channel (feed-only, low-noise).
  async notifyMention(
    tenant: string,
    input: {
      recipients: string[];
      actorName: string; // display name of the person who mentioned (name/username)
      resourceType: string; // "dataset", etc.
      resourceId: string;
      commentId: string;
      preview: string; // comment body preview
    },
  ): Promise<void> {
    const preview = input.preview.trim().replace(/\s+/g, " ").slice(0, 140);
    for (const recipient of [...new Set(input.recipients)]) {
      await this.pushFeed({
        workspace: tenant,
        recipient,
        kind: "comment_mention",
        title: `${input.actorName} mentioned you`,
        body: preview,
        // Generic resource link — the web maps resourceType→path + scrolls to that comment via the commentId anchor.
        link: { resourceType: input.resourceType, resourceId: input.resourceId, commentId: input.commentId },
      });
    }
  }

  // The discussion agent's answer landed on (or fell off) a comment thread — tell the asker, who may have left the
  // page while the turn ran. Reuses the comment_mention kind so the bell's resource-link + anchor machinery applies
  // unchanged. Feed-only (low-noise), best-effort like every notification.
  async notifyAgentAnswer(
    tenant: string,
    input: {
      recipient: string; // the asking member (the agent comment's agentAskedBy)
      resourceType: string;
      resourceId: string;
      commentId: string; // the agent comment — the bell jumps to its anchor
      preview: string; // final answer preview (empty on failure)
      ok: boolean; // complete vs failed
    },
  ): Promise<void> {
    const preview = input.preview.trim().replace(/\s+/g, " ").slice(0, 140);
    await this.pushFeed({
      workspace: tenant,
      recipient: input.recipient,
      kind: "comment_mention",
      title: input.ok ? "Everdict answered in the discussion" : "Everdict couldn't answer your question",
      ...(preview.length > 0 ? { body: preview } : {}),
      link: { resourceType: input.resourceType, resourceId: input.resourceId, commentId: input.commentId },
    });
  }

  // An agent parked on a human decision (HITL, notifications.md N8) — a write-tool or plan approval is
  // waiting and the turn cannot continue until the recipient answers. The park lives on a surface nobody is
  // necessarily watching (one of many conversations, or a resource's discussion thread), so the ask comes to
  // the bell with a link that lands ON that surface: the conversation opens in the side panel
  // (`conversationId`), the discussion lands on the resource page anchored to the agent comment. Feed-only
  // (the bell's native firing already covers "not looking"), best-effort like every notification.
  //
  // The row's id is DETERMINISTIC (one live ask per session/comment — asks are sequential), which buys two
  // things: a re-reported park never duplicates (the store ignores an existing id), and the decision can
  // clear the exact row (`clearApprovalRequest`) — an approval ask stops being true the moment it is decided,
  // so it is deleted rather than left as misleading read-history.
  async notifyApprovalRequested(
    tenant: string,
    input: {
      recipient: string; // whoever the agent is waiting for — the turn's creator / the discussion's asker
      tool?: string; // the parked tool; absent = a plan review
      place: ApprovalPlace;
    },
  ): Promise<void> {
    const title = input.tool !== undefined ? `Approval needed — ${input.tool}` : "Plan review needed";
    await this.pushFeed({
      id: approvalNotificationId(input.place),
      workspace: tenant,
      recipient: input.recipient,
      kind: "agent_approval_requested",
      title,
      body:
        input.place.kind === "discussion"
          ? "Everdict is waiting for your approval in the discussion."
          : "The conversation is parked until you decide.",
      link:
        input.place.kind === "discussion"
          ? {
              resourceType: input.place.resourceType,
              resourceId: input.place.resourceId,
              commentId: input.place.commentId,
            }
          : { conversationId: input.place.sessionId },
    });
  }

  // The ask was decided (allow/deny/expiry) — delete its row. Unlike a completion, a decided approval ask has
  // no residual value: "approval needed" that is no longer needed only misleads, and freeing the deterministic
  // id lets the session's NEXT ask ping again. Best-effort like every notification.
  async clearApprovalRequest(tenant: string, place: ApprovalPlaceKey): Promise<void> {
    if (!this.deps.feed) return;
    try {
      await this.deps.feed.remove(tenant, approvalNotificationId(place));
    } catch {
      // A row that could not be cleared is at worst a stale bell entry — never the caller's failure.
    }
  }

  // Feed write — swallows failures independently of Mattermost (so one channel's outage doesn't block the other).
  // A caller may pin the id (deterministic natural keys — approval asks); the store ignores an existing id.
  private async pushFeed(row: Omit<NotificationRecord, "id" | "createdAt"> & { id?: string }): Promise<void> {
    if (!this.deps.feed) return;
    try {
      await this.deps.feed.add({ ...row, id: row.id ?? this.newId(), createdAt: this.nowIso() });
    } catch {
      // Feed failure never affects the result.
    }
  }

  // Platform-event channel (agent-automation A1) — record the completion FACT (durable log + agent push).
  // Best-effort: an unreachable/unconfigured log or agent never affects the run/scorecard result.
  private async pushEvent(input: EmitPlatformEventInput): Promise<void> {
    if (!this.deps.events) return;
    try {
      await this.deps.events.emit(input);
    } catch {
      // Notification failure never affects the run/scorecard result.
    }
  }

  // Post to EVERY registered Mattermost connection that has a channel (a workspace registers one connection per
  // team/purpose — each is a channel that asked to be notified), via that connection's own bot token. Unset/no-token/
  // failure are silently ignored per connection (notification failure never affects the result, and one dead bot must
  // not silence the others). With `rerun` context + that connection's configured inbound (commandTokenSecretName) + a
  // public URL, its post carries an interactive Rerun button — the click posts back to
  // /integrations/mattermost/action with the embedded context (the same token the slash-command inbound verifies),
  // re-firing dataset×harness from chat.
  private async post(tenant: string, message: string, rerun?: { dataset: string; harness: string }): Promise<void> {
    try {
      const host = this.deps.mattermostHost;
      // Only posts if the operator configured a server URL + there's a transport + a way to resolve the bot token.
      if (!host || !this.deps.mattermost || !this.deps.secretsFor) return;
      const targets = mattermostConnections(await this.deps.settingsFor(tenant)).filter((c) => c.defaultChannelId);
      if (targets.length === 0) return;
      const secrets = await this.deps.secretsFor(tenant);
      const publicUrl = this.deps.apiPublicUrl?.replace(/\/$/, "");
      for (const target of targets) {
        const channelId = target.defaultChannelId;
        const token = secrets[target.botTokenSecretName];
        if (!channelId || !token) continue;
        const actionToken = target.commandTokenSecretName ? secrets[target.commandTokenSecretName] : undefined;
        const attachments =
          rerun && actionToken && publicUrl
            ? [
                {
                  fallback: "Rerun",
                  actions: [
                    {
                      name: "Rerun",
                      integration: {
                        url: `${publicUrl}/integrations/mattermost/action?ws=${encodeURIComponent(tenant)}`,
                        context: {
                          token: actionToken,
                          action: "rerun",
                          dataset: rerun.dataset,
                          harness: rerun.harness,
                        },
                      },
                    },
                  ],
                },
              ]
            : undefined;
        try {
          await this.deps.mattermost.post(host, token, {
            channelId,
            message,
            ...(attachments ? { attachments } : {}),
          });
        } catch {
          // One connection's outage never blocks the others (nor the result).
        }
      }
    } catch {
      // Notification failure never affects the run/scorecard result.
    }
  }
}
