import { CommentService, type DiscussionTurnRunner } from "@everdict/application-control";
import {
  GithubAppService,
  type GithubComAppConfig,
  type GithubEnterpriseAppConfig,
} from "@everdict/application-control";
import { MattermostService } from "@everdict/application-control";
import type { MembershipService } from "@everdict/application-control";
import { NotificationService } from "@everdict/application-control";
import { PlatformEventService } from "@everdict/application-control";
import { SpanAttrMappingService } from "@everdict/application-control";
import { TraceSinkService } from "@everdict/application-control";
import { TraceSourceService } from "@everdict/application-control";
import { UpstreamError } from "@everdict/contracts";
import type { PlatformEventStore } from "@everdict/db";
import type { CommentStore, NotificationStore, OAuthStateStore, WorkspaceSettingsStore } from "@everdict/db";
import { buildTraceSink, buildTraceSource, probeTraceConnection } from "@everdict/trace";
import { agentFetch } from "../common/agent-fetch.js";
import { httpAgentEventSink } from "../infrastructure/agent/agent-event-sink.js";
import { githubAppGateway } from "../infrastructure/github/app-gateway.js";
import { githubRepoTreeReaderFactory, githubRepoWriterFactory } from "../infrastructure/github/repo-writer.js";
import { mattermostHttpClient } from "../infrastructure/mattermost/mattermost-client.js";

// Workspace integration services: completion notifications (Mattermost channel + personal feed), the Mattermost
// registration surface, trace sinks, resource comments (@mention feed), and the workspace GitHub App.
export function buildIntegrations(deps: {
  settingsStore: WorkspaceSettingsStore;
  notificationStore: NotificationStore;
  platformEventStore: PlatformEventStore;
  commentStore: CommentStore;
  oauthStateStore: OAuthStateStore;
  membershipService: MembershipService;
  runtimeSecretsFor: (tenant: string) => Promise<Record<string, string>>;
}) {
  const {
    settingsStore,
    notificationStore,
    platformEventStore,
    commentStore,
    oauthStateStore,
    membershipService,
    runtimeSecretsFor,
  } = deps;
  // Mattermost server URL is an operator env (MATTERMOST_HOST), shared across the deployment — the self-hosted
  // operator registers the server URL once, workspaces never input a host. Unset → Mattermost integration unavailable.
  const mattermostHost = process.env.MATTERMOST_HOST;
  const mattermostClient = mattermostHttpClient(); // outbound posting + connection verify (fetch)
  // Agent event bridge (S4): with the agent service URL + shared internal token, a completion also pushes a platform
  // event to the agent, waking the creator's watching teammates. Unset → skipped (feed/Mattermost unaffected).
  const agentUrl = process.env.AGENT_SERVICE_URL;
  const agentInternalToken = process.env.AGENT_INTERNAL_TOKEN;
  // Platform events (agent-automation A1) — the ONE emit seam for lifecycle facts: append to the durable log,
  // push to the agent service (trigger matching + teammate wake). Both channels best-effort by contract.
  const platformEventService = new PlatformEventService({
    store: platformEventStore,
    ...(agentUrl && agentInternalToken ? { agentEvents: httpAgentEventSink(agentUrl, agentInternalToken) } : {}),
  });
  // Completion notifications: post run/scorecard completion to every registered Mattermost connection that has a channel (consumer slice).
  const notificationService = new NotificationService({
    settingsFor: (tenant) => settingsStore.get(tenant),
    mattermost: mattermostClient, // outbound channel posting adapter (fetch)
    // Workspace Mattermost — resolve each connection's botTokenSecretName from shared secrets.
    secretsFor: runtimeSecretsFor,
    ...(mattermostHost ? { mattermostHost } : {}), // operator server URL (MATTERMOST_HOST) — host is no longer stored per workspace
    feed: notificationStore, // personal notification feed (bell inbox) — docs/architecture/notifications.md
    // Rerun button on completion posts — only attaches when Mattermost can reach us back (public URL known).
    ...(process.env.API_PUBLIC_URL ? { apiPublicUrl: process.env.API_PUBLIC_URL } : {}),
    events: platformEventService,
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
  // Discussion-agent bridge (@everdict in a comment thread) — the report-runner twin: POST the agent service's
  // internal trigger, which acks 202 and runs the turn DETACHED (progress comes back via /internal/comment-activity).
  // Unset env → no runner → askAgent is skipped (the member comment still posts).
  const discussionRunner: DiscussionTurnRunner | undefined =
    agentUrl && agentInternalToken
      ? {
          run: async (input) => {
            let res: Response;
            try {
              // The agent's internal surface says `workspace` (the /agent/events precedent); the port says `tenant`
              // (control-plane vocabulary) — map explicitly, never spread.
              res = await agentFetch(new URL("/internal/discussion-turn", agentUrl), {
                method: "POST",
                headers: { "content-type": "application/json", "x-internal-token": agentInternalToken },
                body: JSON.stringify({
                  workspace: input.tenant,
                  askedBy: input.askedBy,
                  resourceType: input.resourceType,
                  resourceId: input.resourceId,
                  commentId: input.commentId,
                  anchorId: input.anchorId,
                  sessionId: input.sessionId,
                  thread: input.thread,
                }),
              });
            } catch (err) {
              throw new UpstreamError(
                "UPSTREAM_ERROR",
                { commentId: input.commentId },
                `agent discussion service unreachable: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
            if (!res.ok)
              throw new UpstreamError(
                "UPSTREAM_ERROR",
                { commentId: input.commentId, status: res.status },
                `agent discussion trigger failed (${res.status}): ${(await res.text()).slice(0, 300)}`,
              );
          },
        }
      : undefined;
  // Resource comments (datasets, etc.) for collaborative discussion + @mention notifications. On a mention, resolve the mentioner's name from profile/membership into the personal feed.
  const commentService = new CommentService({
    store: commentStore,
    events: platformEventService, // comment.created facts (agent-authored comments excluded in the service)
    ...(discussionRunner ? { discussionRunner } : {}),
    // subject → display name for the discussion agent's thread snapshot (name > email local-part > raw subject).
    memberNames: async (tenant) => {
      const members = await membershipService.listMembers(tenant).catch(() => []);
      return Object.fromEntries(
        members.map((m) => [m.subject, m.name ?? m.email?.split("@")[0] ?? m.subject] as const),
      );
    },
    // The agent's answer landed/failed → ping the asker's bell (they may have left the page while the turn ran).
    notifyAgentAnswer: async ({ tenant, ...input }) => notificationService.notifyAgentAnswer(tenant, input),
    // The discussion turn PARKED on an approval (N8) → ping the asker's bell with a link that lands on the
    // thread's ApprovalStrip — a parked turn nobody notices is a turn that times out to deny.
    notifyApprovalRequested: async ({ tenant, recipient, resourceType, resourceId, commentId, tool }) =>
      notificationService.notifyApprovalRequested(tenant, {
        recipient,
        ...(tool !== undefined ? { tool } : {}),
        place: { kind: "discussion", resourceType, resourceId, commentId },
      }),
    // …and the decision deletes that row again (N8) — a decided ask must not keep saying "approval needed".
    clearApprovalRequest: async ({ tenant, commentId }) =>
      notificationService.clearApprovalRequest(tenant, { kind: "discussion", commentId }),
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
    repoOps: githubRepoWriterFactory(), // per-token repo-ops adapter (agent read tools: get file / list issues)
    trees: githubRepoTreeReaderFactory(), // per-token tree reader (agent read tool: list the repo's files)
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
    platformEventService,
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
