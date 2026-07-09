import { JudgeRunConfigSchema } from "@everdict/core";
import { z } from "zod";
import type { SqlClient } from "../client.js";

// CI repo link — a single record that doubles as the repository ↔ harness service-slot mapping + the GitHub Actions OIDC trust policy.
// The "existence" of a link trusts that repo's GitHub OIDC token into this workspace (no separate policy screen — zero-input).
// Fire-time auth is repo-based federation, so no personal token is used → no creator-left problem (createdBy is for audit).
// Design: docs/architecture/github-actions-trigger.md (D3).
export const WorkspaceCiLinkSchema = z.object({
  repository: z.string().min(1), // "owner/name" (case-insensitive comparison)
  host: z.string().optional(), // GHE base URL (e.g. "https://ghe.acme.io") — unset = github.com. link key = (host, repository).
  harness: z.string().min(1), // harness instance id
  dataset: z.string().optional(), // dataset id the CI will fire — used to generate the setup-PR workflow
  // Service slot → monorepo path filter (optional). The slots this repo's CI swaps out.
  slots: z.record(z.object({ path: z.string().optional() })).default({}),
  createdBy: z.string(), // for audit (unrelated to fire auth)
  disabled: z.boolean().optional(),
  // Placement is always self-hosted (design D6) — the two fields are a narrowing override. Unset = runs-on "[self-hosted]" + the "self:ws" runtime pool.
  runsOn: z.string().optional(), // workflow runs-on value (e.g. "[self-hosted, everdict-<id>]"). The runner label from github-install.
  runtime: z.string().optional(), // run-eval runtime input (e.g. "self:ws:<id>"). A personal runner (self…) is a 400 on upsert.
  // PR-evaluation trigger mode — auto=only automatic PR events · comment=only the /evaluate PR comment (on-demand for an expensive suite) · both (default).
  // push (default-branch re-pin) always fires. Used only for workflow YAML generation (renderCiWorkflow) — unrelated to fire auth (trust).
  trigger: z.enum(["auto", "comment", "both"]).optional(),
});
export type WorkspaceCiLink = z.infer<typeof WorkspaceCiLinkSchema>;

// Per-workspace settings (control-plane policy). Stored as JSONB for easy extension later.
// Per-request overrides (POST /runs·/scorecards body.*) take precedence over this; this value overrides the env default policy.
export const WorkspaceSettingsSchema = z.object({
  meterUsage: z.boolean().optional(), // if unset, falls back to env policy (EVERDICT_METER_TENANTS/EVERDICT_METER_USAGE)
  // Default model used to score an inline judge grader (e.g. the WebVoyager preset). The control plane auto-injects it into the job (job.judge).
  // The key is injected separately from secrets (SecretStore); this holds only the model/provider (not a secret). A per-request override takes precedence.
  judge: JudgeRunConfigSchema.optional(),
  // Workspace-owned Mattermost integration — an admin registers the in-house Mattermost once for the workspace.
  // Outbound notifications = POST /api/v4/posts with the bot token (SecretStore name-ref). Inbound (slash commands/buttons) is a follow-up (S7/S8).
  // nullable: DELETE clears it with null (jsonb merge || can't delete a key, so null invalidates it, treated as undefined on read).
  // Design: docs/architecture/workspace-scoped-integrations.md
  mattermost: z
    .object({
      host: z.string().url(), // in-house Mattermost base URL
      botTokenSecretName: z.string().min(1), // SecretStore key name of the bot access token (the value itself is never stored/returned)
      defaultChannelId: z.string().min(1).optional(), // default channel for completion/regression notifications
      commandTokenSecretName: z.string().min(1).optional(), // slash-command/action verification token name (S7/S8)
      inboundToken: z.string().optional(), // inbound routing token (S7/S8)
    })
    .nullable()
    .optional(),
  // (legacy, read-only compat) singular image registry — superseded by imageRegistries (plural). When a service reads and
  // imageRegistries is absent, it inherits this value as a name="default" entry and clears it to null on the next write.
  imageRegistry: z
    .object({
      host: z.string().min(1),
      namespace: z.string().min(1).optional(),
      username: z.string().min(1).optional(),
      pullSecretName: z.string().min(1).optional(),
      pushSecretName: z.string().min(1).optional(),
    })
    .nullable()
    .optional(),
  // Workspace image registries (BYO, plural) — the classification baseline for harness images + the publish target for everdict image push.
  // Register several by name and select at push time (classification/pull auth matches on host across all of them).
  // All secrets are SecretStore name-refs (values never stored/returned). Design: docs/architecture/workspace-image-registry.md
  imageRegistries: z
    .array(
      z.object({
        name: z.string().min(1), // registry name (reference key — push select/deselect points at this name)
        host: z.string().min(1), // registry host[:port] — "ghcr.io" · "registry.acme.dev:5000"
        namespace: z.string().min(1).optional(), // path prefix under host — "acme" → ghcr.io/acme/<name>:<tag>
        username: z.string().min(1).optional(), // docker login username (omitted for token-only registries)
        pullSecretName: z.string().min(1).optional(), // SecretStore key — pull token/password
        pushSecretName: z.string().min(1).optional(), // SecretStore key — push token/password
      }),
    )
    .optional(),
  // Workspace trace sinks (plural) — export judged scorecard detail results (trace+scores) to the team observability platform (outbound).
  // The mirror of TraceSource (inbound pull). Register several by name and pick one 'per harness' (not one per workspace).
  // Secrets are SecretStore name-refs (values never stored/returned). Design: docs/architecture/trace-sink.md
  traceSinks: z
    .array(
      z.object({
        name: z.string().min(1), // sink name (reference key — a harness selection points at this name)
        kind: z.enum(["mlflow", "langfuse", "langsmith", "phoenix"]),
        endpoint: z.string().url(), // platform API base URL
        authSecretName: z.string().min(1).optional(), // SecretStore key — the auth-header 'value' (omitted for an unauthenticated dev server)
        project: z.string().min(1).optional(), // meaning per kind: mlflow experiment_id · langsmith project · phoenix project · langfuse projectId (link)
        webUrl: z.string().url().optional(), // UI deep-link base (when it differs from the API endpoint — e.g. LangSmith api vs smith)
      }),
    )
    .optional(),
  // Per-harness sink selection (harness id → sink name). A harness with no selection is not exported (opt-in).
  // nullable value: deselection replaces the whole map with a new one rather than deleting a key, due to the nature of jsonb merge (service-managed).
  traceSinkByHarness: z.record(z.string()).optional(),
  // CI integration (GitHub Actions) — the repo-link list (repo↔harness-slot mapping = OIDC trust policy). See WorkspaceCiLinkSchema above.
  ci: z.object({ links: z.array(WorkspaceCiLinkSchema).default([]) }).optional(),
  // Workspace-owned GitHub App integration (replaces personal connections) — org install→selected repos→workspace-owned installation.
  // github.com App = operator env (GITHUB_APP_*); GHE App = admin registers host+App credentials (private key=SecretStore name-ref).
  // The installation issues short-lived tokens on demand with the App private key, so there's no secret here — all safe to return (host/appId/installationId).
  // Design: docs/architecture/workspace-scoped-integrations.md
  githubApp: z
    .object({
      // GHE App registration (github.com is env → not here). Admin registers it once per workspace.
      registrations: z
        .array(
          z.object({
            host: z.string().url(), // GHE base URL
            slug: z.string().min(1), // App slug (used in the install URL /github-apps/{slug}/installations/new)
            appId: z.string().min(1),
            privateKeySecretName: z.string().min(1), // SecretStore key — the PEM value itself is never stored/returned
          }),
        )
        .default([]),
      // Workspace-owned installation (github.com + GHE). One per installed org.
      installations: z
        .array(
          z.object({
            host: z.string().url().optional(), // unset = github.com
            installationId: z.number().int(),
            account: z.string().min(1), // installed org/user login
            connectedBy: z.string(), // for audit — the admin subject who linked it
            connectedAt: z.string(),
          }),
        )
        .default([]),
    })
    .optional(),
});
export type WorkspaceSettings = z.infer<typeof WorkspaceSettingsSchema>;
export interface WorkspaceSettingsStore {
  get(workspace: string): Promise<WorkspaceSettings | undefined>;
  set(workspace: string, patch: WorkspaceSettings): Promise<WorkspaceSettings>; // partial-merge upsert
}

export class InMemoryWorkspaceSettingsStore implements WorkspaceSettingsStore {
  private readonly byWs = new Map<string, WorkspaceSettings>();
  async get(workspace: string): Promise<WorkspaceSettings | undefined> {
    const s = this.byWs.get(workspace);
    return s ? { ...s } : undefined;
  }
  async set(workspace: string, patch: WorkspaceSettings): Promise<WorkspaceSettings> {
    const next = { ...(this.byWs.get(workspace) ?? {}), ...patch };
    this.byWs.set(workspace, next);
    return { ...next };
  }
}

export class PgWorkspaceSettingsStore implements WorkspaceSettingsStore {
  constructor(private readonly client: SqlClient) {}
  async get(workspace: string): Promise<WorkspaceSettings | undefined> {
    const r = await this.client.query<{ settings: unknown }>(
      "SELECT settings FROM everdict_workspace_settings WHERE workspace = $1",
      [workspace],
    );
    return r.rows[0] ? WorkspaceSettingsSchema.parse(r.rows[0].settings) : undefined;
  }
  async set(workspace: string, patch: WorkspaceSettings): Promise<WorkspaceSettings> {
    // Atomic upsert via jsonb merge (||) — does not overwrite other settings keys.
    const r = await this.client.query<{ settings: unknown }>(
      `INSERT INTO everdict_workspace_settings (workspace, settings, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (workspace) DO UPDATE SET settings = everdict_workspace_settings.settings || $2::jsonb, updated_at = now()
       RETURNING settings`,
      [workspace, JSON.stringify(patch)],
    );
    return WorkspaceSettingsSchema.parse(r.rows[0]?.settings ?? patch);
  }
}
