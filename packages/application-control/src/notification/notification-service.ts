import type { NotificationRecord, RunRecord, WorkspaceSettings } from "@everdict/contracts";
import type { MattermostClient } from "../ports/mattermost-client.js";
import type { NotificationListOptions, NotificationStore } from "../ports/notification-store.js";

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
    if (record.createdBy && !record.parentScorecardId && (record.status === "succeeded" || record.status === "failed"))
      await this.pushFeed({
        workspace: tenant,
        recipient: record.createdBy,
        kind: record.status === "succeeded" ? "run_completed" : "run_failed",
        title: `Run ${record.status === "succeeded" ? "completed" : "failed"} — ${record.harness.id}@${record.harness.version}`,
        body: `case ${record.caseId}`,
        link: { runId: record.id },
      });
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
    },
  ): Promise<void> {
    if (record.createdBy && (record.status === "succeeded" || record.status === "failed"))
      await this.pushFeed({
        workspace: tenant,
        recipient: record.createdBy,
        kind: record.status === "succeeded" ? "scorecard_completed" : "scorecard_failed",
        title: `Scorecard ${record.status === "succeeded" ? "completed" : "failed"} — ${record.dataset.id}@${record.dataset.version} × ${record.harness.id}@${record.harness.version}`,
        link: { scorecardId: record.id },
      });
    const icon = record.status === "succeeded" ? "✅" : record.status === "failed" ? "❌" : "•";
    await this.post(
      tenant,
      `${icon} **Scorecard \`${record.id}\`** ${record.status} — dataset \`${record.dataset.id}@${record.dataset.version}\` × \`${record.harness.id}@${record.harness.version}\``,
      { dataset: record.dataset.id, harness: record.harness.id },
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

  // Feed write — swallows failures independently of Mattermost (so one channel's outage doesn't block the other).
  private async pushFeed(row: Omit<NotificationRecord, "id" | "createdAt">): Promise<void> {
    if (!this.deps.feed) return;
    try {
      await this.deps.feed.add({ ...row, id: this.newId(), createdAt: this.nowIso() });
    } catch {
      // Feed failure never affects the result.
    }
  }

  // Scheduled (cron) regression alert — if a regression vs the previous scheduled run is detected, post a high-signal warning to the channel (separate from completion notifications).
  async notifyRegression(
    tenant: string,
    payload: {
      scheduleName: string;
      scorecardId: string;
      previousScorecardId: string;
      regressions: Array<{ caseId: string; metric: string; baseline: number; candidate: number }>;
      createdBy?: string; // schedule creator — personal feed recipient (N2)
    },
  ): Promise<void> {
    if (payload.createdBy)
      await this.pushFeed({
        workspace: tenant,
        recipient: payload.createdBy,
        kind: "schedule_regression",
        title: `Scheduled regression — ${payload.scheduleName} (${payload.regressions.length} regression(s))`,
        body: payload.regressions
          .slice(0, 3)
          .map((r) => `${r.caseId} ${r.metric}: ${r.baseline} → ${r.candidate}`)
          .join(" · "),
        link: { scorecardId: payload.scorecardId },
      });
    const lines = payload.regressions
      .slice(0, 10)
      .map((r) => `• \`${r.caseId}\` ${r.metric}: ${r.baseline} → ${r.candidate}`)
      .join("\n");
    const more = payload.regressions.length > 10 ? `\n…and ${payload.regressions.length - 10} more` : "";
    await this.post(
      tenant,
      `⚠️ **Scheduled regression \`${payload.scheduleName}\`** — ${payload.regressions.length} regression(s) ` +
        `(scorecard \`${payload.scorecardId}\` vs previous \`${payload.previousScorecardId}\`)\n${lines}${more}`,
    );
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
