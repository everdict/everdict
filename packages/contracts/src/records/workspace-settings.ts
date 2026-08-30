import { z } from "zod";
import { JudgeRunConfigSchema } from "../execution/case-job.js";
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
  // ── WHICH REFS OF THAT REPOSITORY THIS WORKSPACE TRUSTS (arch-review 122) ────────────────────────
  //
  // The link used to pin the REPOSITORY and nothing else, while the OIDC token's `ref` was parsed into
  // `GithubActionsClaims` and consulted by nobody. The `ci` role carries `harnesses:register` — the
  // merge-time re-pin that mints a new immutable instance version — and `scorecards:run`, so anyone who
  // could push a BRANCH to the linked repo could register a harness version and spend the workspace's
  // budget. Push access is routinely wider than merge access.
  //
  //     the token is from the linked repo   ≠   it is from a ref this workspace trusts
  //
  // Exact `ref` values, plus a single trailing `*` as a prefix — the one wildcard the domain forces. The
  // generated workflow fires on `pull_request` (ref `refs/pull/<n>/merge`, a different value per PR),
  // `issue_comment` and `push` to the default branch, so a pin of `refs/heads/main` alone would authenticate
  // the merge lane and REFUSE every PR evaluation. The set that matches what CI actually produces is
  // `["refs/heads/<default>", "refs/pull/*"]`.
  // ABSENT = any ref, which is what every link written before this field meant; it is the permissive arm, so
  // it is disclosed rather than silent — `GET /workspace/ci/links` reports it and the setup-PR generator
  // pins the default branch on new links.
  refs: z.array(z.string().min(1)).optional(),
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
  // (legacy, read-only compat) singular Mattermost connection — superseded by mattermostConnections (plural). When a
  // service reads and mattermostConnections is absent, it inherits this value as a name="default" entry and clears it
  // to null on the next write. nullable: the jsonb merge || can't delete a key, so null invalidates it (undefined on read).
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
  // Workspace-owned Mattermost connections (plural) — an admin registers one bot+channel pair per team/purpose against
  // the operator's Mattermost server (MATTERMOST_HOST, shared across the deployment — a workspace never inputs a host).
  // Outbound notifications = POST /api/v4/posts with the bot token (SecretStore name-ref) — completion/regression facts
  // fan out to EVERY connection that has a defaultChannelId. Inbound (slash commands/buttons) is verified against every
  // connection's commandTokenSecretName. Design: docs/architecture/workspace-scoped-integrations.md
  mattermostConnections: z
    .array(
      z.object({
        name: z.string().min(1), // connection name (reference/upsert key, e.g. "team-alerts")
        botTokenSecretName: z.string().min(1), // SecretStore key name of the bot access token (the value itself is never stored/returned)
        defaultChannelId: z.string().min(1).optional(), // channel this connection notifies (absent = no outbound posts)
        commandTokenSecretName: z.string().min(1).optional(), // slash-command/action verification token name (S7/S8)
      }),
    )
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
  // Environment images the workspace has ADOPTED (imported) from the Capability Store — a WORKSPACE-LEVEL inventory
  // (not agent-scoped: environments feed harnesses workspace-wide). Each entry is the immutable-version REF plus a
  // pull-usability verification snapshot taken at adopt / re-verify time (warn-not-block: adoption is recorded even
  // when the image can't be pulled). image/name/contents are NOT duplicated here — they resolve live from the
  // capability record. Design: docs/architecture/environment-image-store.md.
  // N3 ingestion admission (native-observability §8): the workspace override for the OTLP door's quota.
  // Enforced as stored events per rolling hour — past it the door refuses at 429 (visible, never a silent
  // drop). Unset = the operator default (EVERDICT_INGEST_MAX_EVENTS_PER_HOUR); neither = unlimited.
  traceIngestion: z
    .object({
      maxEventsPerHour: z.number().int().positive().optional(),
    })
    .optional(),
  // E4 trace thresholds (native-observability / event-plumbing wave 4): evaluated over EVERY trajectory at
  // seal time by the perception decorator — a crossing lands trace.threshold_crossed on the log (the wake
  // signal for triage agents). metric = a derived number of the sealed trajectory; value = the exceeds-bound
  // (strictly greater). name doubles as the trigger-filter key.
  traceThresholds: z
    .array(
      z.object({
        name: z.string().min(1),
        metric: z.enum(["usd", "total_tokens", "llm_calls", "tool_calls", "tool_failures", "events", "latency_ms_max"]),
        value: z.number().nonnegative(),
      }),
    )
    .optional(),
  adoptedEnvironments: z
    .array(
      z.object({
        source: z.string().min(1), // the OWNER workspace (publisher) of the environment capability
        id: z.string().min(1),
        version: z.string().min(1), // the pinned immutable version
        adoptedAt: z.string(), // ISO timestamp
        verify: z
          .object({
            pullable: z.boolean(), // can THIS workspace pull the image (Docker Registry v2 manifest reachable)?
            reason: z.enum(["ok", "auth", "not-found", "unreachable", "unregistered-host"]).optional(),
            digest: z.string().optional(), // the resolved manifest digest when pullable
            at: z.string(), // ISO timestamp of the check
          })
          .optional(),
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
        // Base URL for ROOT-RELATIVE artifact refs inside pulled traces (evidence slots) — without it the judge
        // receives the raw path string instead of the resolved bytes/text. Pull-only detail.
        artifactBaseUrl: z.string().url().optional(),
        // The tag key `correlate:"tag"` searches — default `everdict.run_id`. A HarnessSpec's inline source
        // has always been able to name a controlled coordinate (`mlflow.trace.session`, paired with
        // frontDoor.contextId); this row could not, and per-harness SELECTION wins over the inline spec — so
        // choosing a registered source silently downgraded correlation to the tag the agent can overwrite,
        // and the pull found nothing. A record that re-describes a spec has to be able to say what it says.
        correlateTag: z.string().min(1).optional(),
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

// One tenant-configured trace threshold (the traceThresholds[] item) — the perception decorator's unit.
export type TraceThreshold = NonNullable<WorkspaceSettings["traceThresholds"]>[number];
