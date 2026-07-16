import { CommentService } from "@everdict/application-control";
import {
  GithubAppService,
  type GithubComAppConfig,
  type GithubEnterpriseAppConfig,
} from "@everdict/application-control";
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
  // Mattermost server URL is an operator env (MATTERMOST_HOST), shared across the deployment — the self-hosted
  // operator registers the server URL once, workspaces never input a host. Unset → Mattermost integration unavailable.
  const mattermostHost = process.env.MATTERMOST_HOST;
  const mattermostClient = mattermostHttpClient(); // outbound posting + connection verify (fetch)
  // Completion notifications: when workspace notify settings exist (Mattermost bot + channel), post run/scorecard completion to the channel (consumer slice).
  const notificationService = new NotificationService({
    settingsFor: (tenant) => settingsStore.get(tenant),
    mattermost: mattermostClient, // outbound channel posting adapter (fetch)
    // Workspace Mattermost (bot token) — resolve settings.mattermost.botTokenSecretName from shared secrets.
    secretsFor: runtimeSecretsFor,
    ...(mattermostHost ? { mattermostHost } : {}), // operator server URL (MATTERMOST_HOST) — host is no longer stored per workspace
    feed: notificationStore, // personal notification feed (bell inbox) — docs/architecture/notifications.md
    // Rerun button on completion posts — only attaches when Mattermost can reach us back (public URL known).
    ...(process.env.API_PUBLIC_URL ? { apiPublicUrl: process.env.API_PUBLIC_URL } : {}),
  });
  // Workspace-owned Mattermost integration (register → bot notifications + inbound slash commands/buttons). host = operator env;
  // set() verifies the bot token (+ channel) against the live server (strict); apiPublicUrl exposes the inbound URL.
  const mattermostService = new MattermostService({
    settings: settingsStore,
    client: mattermostClient,
    secretsFor: runtimeSecretsFor, // botTokenSecretName → value for the connection verify (never returned)
    config: {
      ...(mattermostHost ? { host: mattermostHost } : {}),
      ...(process.env.API_PUBLIC_URL ? { apiPublicUrl: process.env.API_PUBLIC_URL } : {}),
    },
  });
  // Trace-sink EXPORT executor — export scorecard detail results to the source a harness selected as an export target
  // (registration lives on TraceSourceService now). docs/architecture/trace-sink.md
  const traceSinkService = new TraceSinkService(settingsStore, {
    secretsFor: runtimeSecretsFor, // authSecretName → shared (workspace) secret value
    buildSink: buildTraceSink,
  });
  // Workspace trace sources — the ONE registration pool for observability platforms. A harness selects one to PULL its
  // trace from and/or to EXPORT judged results to (use-site choice). resolve() reads the auth value here (transient).
  const traceSourceService = new TraceSourceService(settingsStore, {
    secretsFor: runtimeSecretsFor, // authSecretName → shared (workspace) secret value (point-of-use only)
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
  // BOTH github.com AND GitHub Enterprise are operator env (GITHUB_APP_* / GITHUB_ENTERPRISE_APP_*) — one App per host for
  // the whole deployment; the admin only installs + picks repos. RunService/ScorecardService's installationTokenFor calls this, so create it beforehand.
  const githubComApp = githubComAppConfig();
  const githubEnterpriseApp = githubEnterpriseAppConfig();
  const githubAppService = new GithubAppService({
    states: oauthStateStore,
    settings: settingsStore,
    gateway: githubAppGateway(), // outbound App-JWT/installation-token + installation-repos/runner-token adapter (fetch)
    config: {
      webBaseUrl: process.env.WEB_BASE_URL ?? "http://localhost:3001",
      ...(process.env.API_PUBLIC_URL ? { apiPublicUrl: process.env.API_PUBLIC_URL } : {}),
      ...(githubComApp ? { githubCom: githubComApp } : {}),
      ...(githubEnterpriseApp ? { githubEnterprise: githubEnterpriseApp } : {}),
    },
  });
  if (githubComApp)
    console.error("▶ github-app: github.com App enabled (GITHUB_APP_ID/SLUG) — org install → selected-repo one-click");
  else console.warn("▶ github-app: GITHUB_APP_* unset — github.com App install disabled.");
  if (githubEnterpriseApp)
    console.error(
      `▶ github-app: GitHub Enterprise App enabled for ${githubEnterpriseApp.host} (GITHUB_ENTERPRISE_APP_*) — same one-click install as github.com`,
    );
  else console.warn("▶ github-app: GITHUB_ENTERPRISE_APP_* unset — GitHub Enterprise install disabled.");
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

// PEM decode for env-supplied App private keys: base64(PEM) is recommended for single-line env-file safety;
// if the value contains "BEGIN", raw PEM (with \n escape restoration) is accepted too.
function decodePrivateKeyPem(key: string): string {
  return key.includes("BEGIN") ? key.replace(/\\n/g, "\n") : Buffer.from(key, "base64").toString("utf8");
}

// github.com operator App credentials (env) — all three required to enable. Unset → github.com App install disabled.
function githubComAppConfig(): GithubComAppConfig | undefined {
  const appId = process.env.GITHUB_APP_ID;
  const key = process.env.GITHUB_APP_PRIVATE_KEY;
  const slug = process.env.GITHUB_APP_SLUG;
  if (!appId || !key || !slug) return undefined;
  return { appId, slug, privateKeyPem: decodePrivateKeyPem(key) };
}

// GitHub Enterprise operator App credentials (env) — the single enterprise host for this deployment, handled
// identically to github.com (one env App, install-only). All four required to enable. Unset → GHE install disabled.
function githubEnterpriseAppConfig(): GithubEnterpriseAppConfig | undefined {
  const host = process.env.GITHUB_ENTERPRISE_HOST;
  const appId = process.env.GITHUB_ENTERPRISE_APP_ID;
  const key = process.env.GITHUB_ENTERPRISE_APP_PRIVATE_KEY;
  const slug = process.env.GITHUB_ENTERPRISE_APP_SLUG;
  if (!host || !appId || !key || !slug) return undefined;
  return { host, appId, slug, privateKeyPem: decodePrivateKeyPem(key) };
}
