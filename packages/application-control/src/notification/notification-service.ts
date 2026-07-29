import type { NotificationRecord, RunRecord, WorkspaceSettings } from "@everdict/contracts";
import type { MattermostClient } from "../ports/mattermost-client.js";
import type { NotificationListOptions, NotificationStore } from "../ports/notification-store.js";
import type { EmitPlatformEventInput, PlatformEventEmitter } from "../ports/platform-event-emitter.js";

// Completion notifications — one completion event fans out to two channels [personal feed, Mattermost] (docs/architecture/notifications.md N5).
// Feed: the personal (recipient = record.createdBy) inbox — consumed by the web bell / desktop native notifications (N1/N2).
// Mattermost: posts to a channel if the workspace has notify settings (the existing connected-account consumer slice).
// Notification failure never affects the run/scorecard result (fire-and-forget — the store is the source of truth, and can also be polled).
export interface NotificationServiceDeps {
  settingsFor: (tenant: string) => Promise<WorkspaceSettings | undefined>;
  // Workspace Mattermost (bot token) — resolves settings.mattermost.botTokenSecretName from the workspace SecretStore.
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

export class NotificationService {
  private readonly newId: () => string;
  private readonly nowIso: () => string;
  constructor(private readonly deps: NotificationServiceDeps) {
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.nowIso = deps.now ?? (() => new Date().toISOString());
  }

  async notifyRun(tenant: string, record: RunRecord): Promise<void> {
    // Feed (N2): only top-level runs with a known initiator — scorecard child runs are represented by the single batch entry (flood prevention).
    if (
      record.createdBy &&
      !record.parentScorecardId &&
      (record.status === "succeeded" || record.status === "failed")
    ) {
      await this.pushFeed({
        workspace: tenant,
        recipient: record.createdBy,
        kind: record.status === "succeeded" ? "run_completed" : "run_failed",
        title: `Run ${record.status === "succeeded" ? "completed" : "failed"} — ${record.harness.id}@${record.harness.version}`,
        body: `case ${record.caseId}`,
        link: { runId: record.id },
      });
      // The run.completed/failed FACT now rides the E0 outbox: the Run aggregate's terminal transition
      // computes it and the store persists it atomically with the terminal write (run-service.finalize).
      // This service keeps only the user-facing feed entry above + the Mattermost post below.
    }
    const icon = record.status === "succeeded" ? "✅" : record.status === "failed" ? "❌" : "•";
    await this.post(
      tenant,
      `${icon} **Run \`${record.id}\`** ${record.status} — \`${record.harness.id}@${record.harness.version}\` (case ${record.caseId})`,
    );
  }

  async notifyScorecard(
    tenant: string,
    record: {
      id: string;
      status: string;
      dataset: { id: string; version: string };
      harness: { id: string; version: string };
      createdBy?: string;
      // Provenance — a scorecard fired by a schedule (cron tick or manual "run now") gets a schedule-BRANDED feed
      // notification ("Scheduled run …") in place of the generic one, so the bell reads as "my scheduled job ran".
      origin?: { source?: string };
    },
  ): Promise<void> {
    const scheduled = record.origin?.source === "schedule";
    if (record.createdBy && (record.status === "succeeded" || record.status === "failed")) {
      await this.pushFeed({
        workspace: tenant,
        recipient: record.createdBy,
        kind: scheduled
          ? record.status === "succeeded"
            ? "schedule_completed"
            : "schedule_failed"
          : record.status === "succeeded"
            ? "scorecard_completed"
            : "scorecard_failed",
        title: `${scheduled ? "Scheduled run" : "Scorecard"} ${record.status === "succeeded" ? "completed" : "failed"} — ${record.dataset.id}@${record.dataset.version} × ${record.harness.id}@${record.harness.version}`,
        link: { scorecardId: record.id },
      });
    }
    // The scorecard.completed/failed platform event moved to the E0 outbox: ScorecardBatch.succeed/fail
    // compute the fact (same createdBy gate, passRate pointer included) and the settle persists it
    // atomically with the terminal write — this path keeps only the feed + Mattermost channels.
    const icon = record.status === "succeeded" ? "✅" : record.status === "failed" ? "❌" : "•";
    await this.post(
      tenant,
      `${icon} **Scorecard \`${record.id}\`** ${record.status} — dataset \`${record.dataset.id}@${record.dataset.version}\` × \`${record.harness.id}@${record.harness.version}\``,
      { dataset: record.dataset.id, harness: record.harness.id },
    );
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
        ...(input.artifactId !== undefined ? { artifactId: input.artifactId } : {}),
      },
      message: `Scheduled report "${input.scheduleName}" is ready on view ${input.viewId}${input.artifactId ? ` (artifact ${input.artifactId})` : " (no artifact produced)"}.`,
    });
    await this.post(
      tenant,
      `📈 **Report ready — ${input.scheduleName}** (view \`${input.viewId}\`)${input.artifactId ? "" : " — no report artifact was produced"}`,
    );
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

  // Feed write — swallows failures independently of Mattermost (so one channel's outage doesn't block the other).
  private async pushFeed(row: Omit<NotificationRecord, "id" | "createdAt">): Promise<void> {
    if (!this.deps.feed) return;
    try {
      await this.deps.feed.add({ ...row, id: this.newId(), createdAt: this.nowIso() });
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

  // Post to a channel via the workspace-registered Mattermost (bot token). Unset/no-token/failure are silently ignored (notification failure never affects the result).
  // With `rerun` context + configured inbound (commandTokenSecretName) + a public URL, the post carries an
  // interactive Rerun button — the click posts back to /integrations/mattermost/action with the embedded
  // context (the same token the slash-command inbound verifies), re-firing dataset×harness from chat.
  private async post(tenant: string, message: string, rerun?: { dataset: string; harness: string }): Promise<void> {
    try {
      const mm = (await this.deps.settingsFor(tenant))?.mattermost;
      const host = this.deps.mattermostHost;
      // Only posts if the operator configured a server URL + there's a transport + a defaultChannelId + a bot token in the SecretStore.
      if (!host || !this.deps.mattermost || !mm?.defaultChannelId || !this.deps.secretsFor) return;
      const secrets = await this.deps.secretsFor(tenant);
      const token = secrets[mm.botTokenSecretName];
      if (!token) return;
      const actionToken = mm.commandTokenSecretName ? secrets[mm.commandTokenSecretName] : undefined;
      const publicUrl = this.deps.apiPublicUrl?.replace(/\/$/, "");
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
                      context: { token: actionToken, action: "rerun", dataset: rerun.dataset, harness: rerun.harness },
                    },
                  },
                ],
              },
            ]
          : undefined;
      await this.deps.mattermost.post(host, token, {
        channelId: mm.defaultChannelId,
        message,
        ...(attachments ? { attachments } : {}),
      });
    } catch {
      // Notification failure never affects the run/scorecard result.
    }
  }
}
