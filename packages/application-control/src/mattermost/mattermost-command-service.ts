import { timingSafeEqual } from "node:crypto";
import { ForbiddenError } from "@everdict/contracts";
import type { WorkspaceSettingsStore } from "../ports/workspace-settings-store.js";

// Handles Mattermost inbound (slash commands + interactive buttons) — Everdict's first inbound surface.
// The workspace is routed by URL (?ws=), and authenticity is verified with a **constant-time comparison** of the request token against the commandTokenSecretName value (fail-closed).
// Design: docs/architecture/workspace-scoped-integrations.md (S7/S8)

function constantTimeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
function trimSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

// Mattermost slash-command reply — response_type=in_channel (visible to all) | ephemeral (caller only).
export interface MattermostReply {
  response_type: "ephemeral" | "in_channel";
  text: string;
}

export interface MattermostCommandServiceDeps {
  settings: WorkspaceSettingsStore;
  secretsFor: (workspace: string) => Promise<Record<string, string>>;
  // Fire a scorecard from chat (optional) — if absent, run/rerun is disabled. Build the link from the returned id.
  submitScorecard?: (
    workspace: string,
    input: { dataset: string; harness: string; submittedBy: string },
  ) => Promise<{ id: string }>;
  // Leaderboard lookup (optional) — returns {label,value} rows (this service does the formatting).
  leaderboard?: (workspace: string, datasetId: string) => Promise<Array<{ label: string; value: string }>>;
  webBaseUrl?: string; // base for result links
}

export class MattermostCommandService {
  constructor(private readonly deps: MattermostCommandServiceDeps) {}

  // Inbound verification — constant-time compare against the commandTokenSecretName value. Unset / no token / mismatch are all rejected (fail-closed).
  private async verify(workspace: string, token?: string): Promise<void> {
    const mm = (await this.deps.settings.get(workspace))?.mattermost;
    if (!mm?.commandTokenSecretName)
      throw new ForbiddenError("FORBIDDEN", { workspace }, "This workspace has no Mattermost inbound configured.");
    const expected = (await this.deps.secretsFor(workspace))[mm.commandTokenSecretName];
    if (!expected || !token || !constantTimeEq(token, expected))
      throw new ForbiddenError("FORBIDDEN", { workspace }, "Mattermost request token verification failed.");
  }

  // Slash command `/everdict <sub> …` — verify, then parse and dispatch. token/text/user_name are MM form fields.
  async handleCommand(
    workspace: string,
    input: { token?: string; text?: string; userName?: string },
  ): Promise<MattermostReply> {
    await this.verify(workspace, input.token);
    const parts = (input.text ?? "").trim().split(/\s+/).filter(Boolean);
    const sub = (parts[0] ?? "help").toLowerCase();

    if (sub === "status")
      return {
        response_type: "ephemeral",
        text: `Everdict workspace **${workspace}** connected. \`run\` · \`leaderboard\` · \`help\` available.`,
      };

    if (sub === "run") {
      if (!this.deps.submitScorecard)
        return { response_type: "ephemeral", text: "Chat runs are disabled in this deployment." };
      const harness = parts[1];
      const dataset = parts[2];
      if (!harness || !dataset)
        return { response_type: "ephemeral", text: "Usage: `/everdict run <harness> <dataset>`" };
      const sc = await this.deps.submitScorecard(workspace, {
        dataset,
        harness,
        submittedBy: `mattermost:${input.userName ?? "user"}`,
      });
      const link = this.deps.webBaseUrl
        ? ` — ${trimSlash(this.deps.webBaseUrl)}/${encodeURIComponent(workspace)}/scorecards/${sc.id}`
        : "";
      return {
        response_type: "in_channel",
        text: `▶️ Scorecard run started: \`${harness}\` × \`${dataset}\` (id \`${sc.id}\`)${link}`,
      };
    }

    if (sub === "leaderboard") {
      if (!this.deps.leaderboard) return { response_type: "ephemeral", text: "The leaderboard is disabled." };
      const dataset = parts[1];
      if (!dataset) return { response_type: "ephemeral", text: "Usage: `/everdict leaderboard <dataset>`" };
      const rows = await this.deps.leaderboard(workspace, dataset);
      if (rows.length === 0) return { response_type: "ephemeral", text: `The \`${dataset}\` leaderboard is empty.` };
      const body = rows
        .slice(0, 10)
        .map((r, i) => `${i + 1}. \`${r.label}\` — ${r.value}`)
        .join("\n");
      return { response_type: "in_channel", text: `🏆 **${dataset}** leaderboard\n${body}` };
    }

    return this.help();
  }

  private help(): MattermostReply {
    return {
      response_type: "ephemeral",
      text: [
        "**Everdict** commands:",
        "• `/everdict run <harness> <dataset>` — run a scorecard",
        "• `/everdict leaderboard <dataset>` — leaderboard",
        "• `/everdict status` — check the connection",
      ].join("\n"),
    };
  }

  // Interactive button (action) — verify the token carried in context, then perform the given action (currently: scorecard rerun).
  async handleAction(
    workspace: string,
    input: { token?: string; action?: string; context?: { dataset?: string; harness?: string; userName?: string } },
  ): Promise<{ ephemeral_text: string }> {
    await this.verify(workspace, input.token);
    if (input.action === "rerun" && this.deps.submitScorecard && input.context?.dataset && input.context?.harness) {
      const sc = await this.deps.submitScorecard(workspace, {
        dataset: input.context.dataset,
        harness: input.context.harness,
        submittedBy: `mattermost:${input.context.userName ?? "button"}`,
      });
      return { ephemeral_text: `▶️ Rerun started (id ${sc.id})` };
    }
    return { ephemeral_text: "Unknown action." };
  }
}
