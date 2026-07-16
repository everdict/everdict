import { CommentService } from "@everdict/application-control";
import { GithubAppService, type GithubComAppConfig } from "@everdict/application-control";
import { MattermostService } from "@everdict/application-control";
import type { MembershipService } from "@everdict/application-control";
import { NotificationService } from "@everdict/application-control";
import { SpanAttrMappingService } from "@everdict/application-control";
import { TraceSinkService } from "@everdict/application-control";
import { TraceSourceService } from "@everdict/application-control";
import type { CommentStore, NotificationStore, OAuthStateStore, WorkspaceSettingsStore } from "@everdict/db";
import { buildTraceSink, buildTraceSource, probeTraceConnection } from "@everdict/trace";
import { githubAppGateway } from "../infrastructure/github/app-gateway.js";
import { mattermostHttpClient } from "../infrastructure/mattermost/mattermost-client.js";

// Workspace integration services: completion notifications (Mattermost channel + personal feed), the Mattermost
// registration surface, trace sinks, resource comments (@mention feed), and the workspace GitHub App.
export function buildIntegrations(deps: {
  settingsStore: WorkspaceSettingsStore;
  notificationStore: NotificationStore;
  commentStore: CommentStore;
  oauthStateStore: OAuthStateStore;
  membershipService: MembershipService;
  runtimeSecretsFor: (tenant: string) => Promise<Record<string, string>>;
}) {
  const { settingsStore, notificationStore, commentStore, oauthStateStore, membershipService, runtimeSecretsFor } =
    deps;
  // Completion notifications: when workspace notify settings exist (Mattermost connection + channel), post run/scorecard completion to the channel (consumer slice).
  const notificationService = new NotificationService({
    settingsFor: (tenant) => settingsStore.get(tenant),
    mattermost: mattermostHttpClient(), // outbound channel posting adapter (fetch)
    // Workspace Mattermost (bot token) — resolve settings.mattermost.botTokenSecretName from shared secrets.
    secretsFor: runtimeSecretsFor,
    feed: notificationStore, // personal notification feed (bell inbox) — docs/architecture/notifications.md
    // Rerun button on completion posts — only attaches when Mattermost can reach us back (public URL known).
    ...(process.env.API_PUBLIC_URL ? { apiPublicUrl: process.env.API_PUBLIC_URL } : {}),
  });
  // Workspace-owned Mattermost integration (register → bot notifications + inbound slash commands/buttons). apiPublicUrl exposes the inbound URL.
  const mattermostService = new MattermostService(settingsStore, {
    ...(process.env.API_PUBLIC_URL ? { apiPublicUrl: process.env.API_PUBLIC_URL } : {}),
  });
  // Workspace trace sinks — export scorecard detail results to the team's observability platform. docs/architecture/trace-sink.md
  const traceSinkService = new TraceSinkService(settingsStore, {
    secretsFor: runtimeSecretsFor, // authSecretName → shared (workspace) secret value
    buildSink: buildTraceSink,
    probeConnection: probeTraceConnection, // connection test + scope discovery before registering
  });
  // Workspace trace sources (inbound mirror) — register a dev-cluster observability endpoint by name; a service harness
  // selects one so everdict pulls that case's trace from it after the run. resolve() reads the auth value here (transient).
  const traceSourceService = new TraceSourceService(settingsStore, {
    secretsFor: runtimeSecretsFor, // authSecretName → shared (workspace) secret value (pull-time only)
    probeConnection: probeTraceConnection, // connection test + scope discovery before registering
    buildSource: buildTraceSource, // config → BrowsableTraceSource — powers the observability browser (listTraces/inspect)
  });
  // Per-harness span-attribute mapping overlay — the mutable conversion layer between a harness and a judge, authored
  // in the judge wizard against a real trace and applied at the trace-collection seams (resolveHarnessTraceMapping).
  const spanAttrMappingService = new SpanAttrMappingService(settingsStore);
  // Resource comments (datasets, etc.) for collaborative discussion + @mention notifications. On a mention, resolve the mentioner's name from profile/membership into the personal feed.
  const commentService = new CommentService({
    store: commentStore,
    notifyMention: async ({ tenant, comment, recipients }) => {
      // listMembers already merges in profile names — the mentioner's display name (name > email local-part > default).
      const member = await membershipService
        .listMembers(tenant)
        .then((ms) => ms.find((m) => m.subject === comment.author))
        .catch(() => undefined);
      const actorName = member?.name ?? member?.email?.split("@")[0] ?? "someone";
      await notificationService.notifyMention(tenant, {
        recipients,
        actorName,
        resourceType: comment.resourceType,
        resourceId: comment.resourceId,
        commentId: comment.id,
        preview: comment.body,
      });
    },
  });
  // Workspace-owned GitHub App integration — org install → selected repos → workspace-owned installation (replaces personal connections).
  // github.com App = operator env (GITHUB_APP_*); GHE App = admin registers it on the workspace (private key = SecretStore name-ref).
  // RunService/ScorecardService's installationTokenFor calls this, so create it beforehand.
  const githubComApp = githubComAppConfig();
  const githubAppService = new GithubAppService({
    states: oauthStateStore,
    settings: settingsStore,
    secretsFor: runtimeSecretsFor,
    gateway: githubAppGateway(), // outbound App-JWT/installation-token + installation-repos/runner-token adapter (fetch)
    config: {
      webBaseUrl: process.env.WEB_BASE_URL ?? "http://localhost:3001",
      ...(process.env.API_PUBLIC_URL ? { apiPublicUrl: process.env.API_PUBLIC_URL } : {}),
      ...(githubComApp ? { githubCom: githubComApp } : {}),
    },
  });
  if (githubComApp)
    console.error("▶ github-app: github.com App enabled (GITHUB_APP_ID/SLUG) — org install → selected-repo one-click");
  else
    console.warn(
      "▶ github-app: GITHUB_APP_* unset — github.com App install disabled (GHE still works when an admin registers it on the workspace).",
    );
  return {
    notificationService,
    mattermostService,
    traceSinkService,
    traceSourceService,
    spanAttrMappingService,
    commentService,
    githubAppService,
  };
}

// External account-connection provider registry.
//  - github (github.com): one-click (default) if the env default OAuth App exists. Otherwise it registers but doesn't appear in the connectable list.
//  - github-enterprise: same github impl + self-hosted (on connect, enter host + clientId + clientSecretName).
//  - mattermost: self-hosted only.
// A self-hosted client_secret value is resolved by NAME from the workspace SecretStore (the value is never stored in the spec/state).
// github.com operator App credentials (env) — all three required to enable. For the private key (PEM), for single-line env-file safety,
// base64(PEM) is recommended; if it contains "BEGIN", raw PEM (with \n escape restoration) is also accepted. Unset → github.com App install disabled.
function githubComAppConfig(): GithubComAppConfig | undefined {
  const appId = process.env.GITHUB_APP_ID;
  const key = process.env.GITHUB_APP_PRIVATE_KEY;
  const slug = process.env.GITHUB_APP_SLUG;
  if (!appId || !key || !slug) return undefined;
  const privateKeyPem = key.includes("BEGIN") ? key.replace(/\\n/g, "\n") : Buffer.from(key, "base64").toString("utf8");
  return { appId, slug, privateKeyPem };
}
