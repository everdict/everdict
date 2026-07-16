import { z } from "zod";
import { JudgeRunConfigSchema } from "../execution/agent-job.js";
import { SpanAttrMappingSchema } from "../execution/trace-source.js";

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

// A BYO egress proxy the workspace registers per country (browser-profiles S4). A profile / interactive session picks
// a country → the control plane resolves it to this proxy and launches the browser with --proxy-server=<url>, so the
// login (and later the eval, S5) run from that geo. authSecretName is a SecretStore key holding "user:pass" (values
// never stored/returned). Design: docs/architecture/browser-profiles.md.
export const WorkspaceProxySchema = z.object({
  name: z.string().min(1), // proxy name (reference key)
  country: z.string().min(1), // country code/label a profile or session picks by (e.g. "US", "DE")
  url: z.string().min(1), // proxy server URL — host:port or scheme://host:port (fed to Chrome --proxy-server)
  authSecretName: z.string().min(1).optional(), // SecretStore key — the proxy "user:pass" (omitted for an open proxy)
});
export type WorkspaceProxy = z.infer<typeof WorkspaceProxySchema>;

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
      // (legacy, optional) the in-house Mattermost base URL is now an operator env (MATTERMOST_HOST), shared across
      // the deployment — the self-hosted operator registers the server URL once, workspaces never input it. Kept
      // optional so pre-env rows still parse; no longer written (the service sources the host from env).
      host: z.string().url().optional(),
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
  // (legacy, read-only compat) workspace trace sinks — superseded by traceSources (unified "Trace Source" pool).
  // Registration is now ONE pool: a trace source is used to pull (traceSourceByHarness) OR to export
  // (traceSinkByHarness) at the per-harness use-site. On read, a legacy sink is merged into the source pool by name
  // (kind/endpoint/auth/project/webUrl, correlate default "id"); the next write persists into traceSources and clears
  // this to null. Design: docs/architecture/trace-sink.md
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
  // Per-harness EXPORT selection (harness id → trace-source name used as an export target). A harness with no selection
  // is not exported (opt-in). The referenced name is a traceSources[] entry (a sink-capable kind, i.e. not otel).
  // nullable value: deselection replaces the whole map with a new one rather than deleting a key, due to the nature of jsonb merge (service-managed).
  traceSinkByHarness: z.record(z.string()).optional(),
  // Workspace trace sources (plural) — the ONE registration pool for observability platforms
  // (OTel/MLflow/Langfuse/LangSmith/Phoenix). Register a platform by name; a harness picks one 'per harness' to PULL its
  // trace from after a case runs (traceSourceByHarness) and/or to EXPORT judged results to (traceSinkByHarness). Whether a
  // source is used to pull or to export is a use-site (per-harness) decision, not a registration one. Secrets are
  // SecretStore name-refs (values never stored/returned). Design: docs/architecture/trace-sink.md + docs/service-harness.md.
  traceSources: z
    .array(
      z.object({
        name: z.string().min(1), // source name (reference key — a harness selection points at this name)
        kind: z.enum(["otel", "mlflow", "langfuse", "langsmith", "phoenix"]),
        endpoint: z.string().url(), // platform query API base URL (reachable from the control plane at pull time)
        authSecretName: z.string().min(1).optional(), // SecretStore key — verbatim auth-header value (omitted for an unauthenticated dev server)
        // How a pulled trace is found in the platform: id = the everdict runId IS the trace id (the agent honored the
        // injected id) | tag = the deployed agent minted its own id but tagged it everdict.run_id → search by that tag.
        // Pull-only detail; ignored when the source is used as an export target.
        correlate: z.enum(["id", "tag"]).default("id"),
        service: z.string().min(1).optional(), // otel/jaeger tag-search scope (the agent's service.name) — required for otel correlate:"tag"
        project: z.string().min(1).optional(), // scope per kind: mlflow experiment_id · phoenix/langfuse/langsmith project — required for mlflow/phoenix
        webUrl: z.string().url().optional(), // export deep-link base when it differs from the API endpoint (used when the source is an export target)
      }),
    )
    .optional(),
  // Per-harness source selection (harness id → source name). A harness with no selection falls back to its inline spec
  // traceSource (or none). Same jsonb-merge / service-managed replace semantics as traceSinkByHarness.
  traceSourceByHarness: z.record(z.string()).optional(),
  // Per-harness span-attribute mapping overlay (harness id → SpanAttrMapping). The mutable conversion layer that sits
  // BETWEEN a harness (which produces spans in its own instrumentation shape) and a judge (which consumes normalized
  // TraceEvents) — independently editable without bumping the immutable harness/judge version. Overrides the harness
  // spec's traceSource.mapping when resolving a trace source (resolveHarnessTraceMapping). Authored in the judge wizard
  // against a real picked trace; applied at the control-plane trace-collection seams (dispatch-after judge + pull-eval).
  // Same jsonb-merge / service-managed replace semantics as traceSourceByHarness. Design: docs/architecture/judge-input-contract.md
  spanAttrMappingByHarness: z.record(SpanAttrMappingSchema).optional(),
  // BYO egress proxies (browser-profiles S4) — per-country proxy pool for the interactive login browser (and eval
  // browsers, S5). Register by name; a session/profile selects a country → resolve to --proxy-server. Secrets are
  // SecretStore name-refs (values never stored/returned). Design: docs/architecture/browser-profiles.md.
  proxies: z.array(WorkspaceProxySchema).optional(),
  // CI integration (GitHub Actions) — the repo-link list (repo↔harness-slot mapping = OIDC trust policy). See WorkspaceCiLinkSchema above.
  ci: z.object({ links: z.array(WorkspaceCiLinkSchema).default([]) }).optional(),
  // Workspace-owned GitHub App integration (replaces personal connections) — org install→selected repos→workspace-owned installation.
  // Both github.com AND GitHub Enterprise are operator env (GITHUB_APP_* / GITHUB_ENTERPRISE_APP_*) — one App per host for
  // the whole deployment; the admin only installs+picks repos (no per-workspace App registration). The installation issues
  // short-lived tokens on demand with the App private key, so there's no secret here — all safe to return (host/installationId).
  // Design: docs/architecture/workspace-scoped-integrations.md
  githubApp: z
    .object({
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
