import { randomUUID } from "node:crypto";
import {
  type AgentRegistry,
  type AgentSessionStore,
  type AnalysisArtifactStore,
  type CapabilityStore,
  Metrics,
  type SecretStore,
  type SubscriptionStore,
  type TenantKeyStore,
  WEBSEARCH_SECRET_NAME,
  registryLatestVersionResolver,
} from "@everdict/application-control";
import {
  InMemoryAgentSessionStore,
  InMemoryAnalysisArtifactStore,
  PgAgentMemberPreferenceStore,
  PgAgentSessionStore,
  PgAnalysisArtifactStore,
  PgCapabilityStore,
  PgSecretStore,
  PgSkillStore,
  PgSubscriptionStore,
  PgTenantKeyStore,
  PgWorkspaceSettingsStore,
  cipherFromEnv,
  makePool,
  sqlClient,
} from "@everdict/db";
import { configuredIntegrations } from "@everdict/domain";
import { LocalDriver } from "@everdict/drivers";
import {
  PgAgentRegistry,
  PgDatasetRegistry,
  PgHarnessInstanceRegistry,
  PgHarnessTemplateRegistry,
  PgJudgeRegistry,
  PgModelRegistry,
  PgRubricRegistry,
  PgRuntimeRegistry,
} from "@everdict/registry";
import { type ActivationEvent, startEventReconcile } from "./agent-activation.js";
import type { CodeToolRuntime } from "./code-tools.js";
import { commentActivityReporter } from "./comment-activity.js";
import { type AgentConfig, loadConfig } from "./config.js";
import { mcpToolProvider } from "./mcp-tools.js";
import {
  type ModelByIdResolver,
  type ModelResolver,
  envModelResolver,
  registryModelByIdResolver,
  registryModelResolver,
} from "./model.js";
import { meAuthenticate, viewAccessChecker } from "./principal.js";
import {
  type ProfileResolver,
  baseProfileResolver,
  registryProfileResolver,
  registrySubagentTypes,
} from "./profile.js";
import { installProxyDispatcher } from "./proxy-dispatcher.js";
import { buildServer } from "./server.js";
import { EVERDICT_AGENT_SYSTEM_PROMPT } from "./system-prompt.js";
import { admissionBridge, approvalBridge, runEventReporter, usageReporter } from "./usage.js";

function envModelFallback(config: AgentConfig): ModelResolver {
  if (config.AGENT_LLM_API_KEY === undefined || config.AGENT_LLM_MODEL === undefined) {
    throw new Error(
      "No agent model configured: set AGENT_MODEL (with DATABASE_URL + EVERDICT_SECRETS_KEY) or AGENT_LLM_API_KEY + AGENT_LLM_MODEL.",
    );
  }
  return envModelResolver({
    apiKey: config.AGENT_LLM_API_KEY,
    model: config.AGENT_LLM_MODEL,
    ...(config.AGENT_LLM_BASE_URL !== undefined ? { baseURL: config.AGENT_LLM_BASE_URL } : {}),
  });
}

async function main(): Promise<void> {
  // Proxy-aware outbound: install a global dispatcher FIRST (before any client fetches) so every outbound call
  // (LLM providers, web search, GitHub/Mattermost integration actions) honors HTTP(S)_PROXY / NO_PROXY behind a
  // corporate proxy. No-op when no proxy env is set.
  const proxy = installProxyDispatcher();
  if (proxy) console.log(`[everdict-agent] outbound proxy: ${proxy.httpsProxy ?? proxy.httpProxy} (NO_PROXY honored)`);

  const config = loadConfig();

  let sessions: AgentSessionStore;
  let artifacts: AnalysisArtifactStore;
  let resolveModel: ModelResolver;
  // Per-workspace agent customization (Phase 1). resolveProfile is always set (base fallback when no DB / no key);
  // resolveModelById is only available with a DB + secrets key (needed to resolve an AgentSpec.model override's key).
  let resolveProfile: ProfileResolver = baseProfileResolver(EVERDICT_AGENT_SYSTEM_PROMPT);
  let resolveModelById: ModelByIdResolver | undefined;
  // The workspace's crafted agents as spawnable sub-agent types (needs the agent registry — DB only).
  let listSubagentTypes: ReturnType<typeof registrySubagentTypes> | undefined;
  // Teammate execution tokens (S3) are issued into the shared tenant-key table — only with a DB (else spawn is 404).
  let keyStore: TenantKeyStore | undefined;
  // Registry-driven trigger activation (agent-automation A3) — with a DB+KEK, platform events match enabled
  // crafted agents' triggers and launch headless runs.
  let activationRegistry: AgentRegistry | undefined;
  // E3 subscription registry — reaction.kind="agent" rules matched next to spec triggers (needs only a DB).
  let subscriptionStore: SubscriptionStore | undefined;
  // Code-tool try (check/run before publish/adopt) — the capability store resolves published refs (any DB), the
  // secret store binds requiredSecrets by name (needs the KEK).
  let tryCapabilityStore: CapabilityStore | undefined;
  let trySecretStore: SecretStore | undefined;
  if (config.DATABASE_URL !== undefined) {
    const client = sqlClient(makePool(config.DATABASE_URL));
    sessions = new PgAgentSessionStore(client);
    artifacts = new PgAnalysisArtifactStore(client);
    keyStore = new PgTenantKeyStore(client);
    tryCapabilityStore = new PgCapabilityStore(client);
    subscriptionStore = new PgSubscriptionStore(client);
    const cipher = cipherFromEnv();
    if (cipher !== undefined) {
      // With the KEK we can decrypt the workspace's model + MCP-server secrets → full per-workspace customization.
      const secretStore = new PgSecretStore(client, cipher);
      trySecretStore = secretStore;
      const modelRegistry = new PgModelRegistry(client);
      const agentRegistry = new PgAgentRegistry(client);
      activationRegistry = agentRegistry;
      resolveModel =
        config.AGENT_MODEL !== undefined
          ? registryModelResolver({ modelRegistry, secretStore, modelRef: config.AGENT_MODEL })
          : envModelFallback(config);
      resolveModelById = registryModelByIdResolver({ modelRegistry, secretStore });
      const settingsStore = new PgWorkspaceSettingsStore(client);
      // Latest-version resolution for skill freshness (the knowledge-layer staleness contract): a skill pinning
      // harness@2.1.0 surfaces as stale once the registry's latest moved on. Best-effort inside the resolver.
      const harnessTemplateRegistry = new PgHarnessTemplateRegistry(client);
      const latestVersionOf = registryLatestVersionResolver({
        datasets: new PgDatasetRegistry(client),
        judges: new PgJudgeRegistry(client),
        runtimes: new PgRuntimeRegistry(client),
        models: modelRegistry,
        rubrics: new PgRubricRegistry(client),
        harnesses: new PgHarnessInstanceRegistry(client, harnessTemplateRegistry),
        agents: agentRegistry,
      });
      resolveProfile = registryProfileResolver({
        agentRegistry,
        secretStore,
        skillStore: new PgSkillStore(client),
        capabilityStore: new PgCapabilityStore(client),
        // The caller's own decisions (Settings › Agent › Tools + › Skills) — resolved per turn, so the agent answers
        // each member with THEIR tools and THEIR procedures instead of one workspace-wide set.
        preferences: new PgAgentMemberPreferenceStore(client),
        baseSystemPrompt: EVERDICT_AGENT_SYSTEM_PROMPT,
        configId: config.AGENT_CONFIG_ID,
        latestVersionOf,
        // Operator-global values for the first-party default tools, keyed by the secret name each default declares.
        defaultToolSecrets: config.AGENT_WEBSEARCH_API_KEY
          ? { [WEBSEARCH_SECRET_NAME]: config.AGENT_WEBSEARCH_API_KEY }
          : {},
        // The integration gate for the gated first-party defaults — derived from the workspace's own settings
        // (GitHub App installed / Mattermost set / image registry registered). Best-effort inside the resolver.
        integrationsConfigured: async (workspace) => configuredIntegrations(await settingsStore.get(workspace)),
      });
      // Crafted agents become spawn_agent(subagent_type) roles (builtins keep name precedence in the chat).
      listSubagentTypes = registrySubagentTypes(agentRegistry, config.AGENT_CONFIG_ID);
    } else {
      // No KEK: sessions persist, but a registered model / secret-backed customization can't be decrypted → env model + base agent.
      if (config.AGENT_MODEL !== undefined) {
        throw new Error("AGENT_MODEL requires EVERDICT_SECRETS_KEY to decrypt the model's API key.");
      }
      resolveModel = envModelFallback(config);
    }
  } else {
    sessions = new InMemoryAgentSessionStore();
    artifacts = new InMemoryAnalysisArtifactStore();
    resolveModel = envModelFallback(config);
  }

  // Code capabilities (type:'code') run in a provisioned compute. The default agent uses a LocalDriver (host
  // subprocess — dev / self-hosted, matching "LocalDriver = inside the agent"); it is NOT isolated, so own-workspace
  // code runs while adopted-from-others code is skipped (the buildCodeTools sandbox gate). A managed deployment
  // injects an isolated driver (DockerDriver) to run adopted code safely.
  const localDriver = new LocalDriver();
  const codeRuntime: CodeToolRuntime = { provision: (spec) => localDriver.provision(spec), isolated: false };

  // Agent-plane observability: the chat host meters loop resilience events (turn outcomes/durations, retries,
  // fallbacks, truncations, compactions, tool failures) into this registry; exposed below as GET /metrics.
  const metrics = new Metrics();

  const app = buildServer({
    metrics,
    authenticate: meAuthenticate(config.CONTROL_PLANE_URL),
    checkViewAccess: viewAccessChecker(config.CONTROL_PLANE_URL), // view-artifacts gallery gate (analysis-studio V3)
    sessions,
    artifacts,
    // run_analysis (V5) opt-in — model-authored scripts additionally require an ISOLATED runtime (the builder
    // refuses a non-isolated host regardless of the flag).
    ...(process.env.AGENT_ALLOW_RUN_ANALYSIS === "true" ? { analysisScriptRuntime: codeRuntime } : {}),
    resolveModel,
    resolveProfile,
    ...(listSubagentTypes ? { listSubagentTypes } : {}),
    ...(resolveModelById ? { resolveModelById } : {}),
    ...(keyStore ? { keyStore } : {}),
    ...(activationRegistry ? { agentRegistry: activationRegistry } : {}),
    ...(subscriptionStore ? { subscriptions: subscriptionStore } : {}),
    // §5.1: activations ask the CP's tenant budget before launching (fail-open on transport, deny on 402).
    ...(config.CONTROL_PLANE_INTERNAL_TOKEN !== undefined
      ? { admitRun: admissionBridge(config.CONTROL_PLANE_URL, config.CONTROL_PLANE_INTERNAL_TOKEN) }
      : {}),
    // Code-tool verification (check/run before publish or adopt) — always available (the runtime exists even
    // without a DB; a missing store just disables ref targets / secret binding inside the try).
    codeTry: {
      runtime: codeRuntime,
      ...(trySecretStore ? { secretStore: trySecretStore } : {}),
      ...(tryCapabilityStore ? { capabilityStore: tryCapabilityStore } : {}),
    },
    ...(config.AGENT_INTERNAL_TOKEN !== undefined ? { internalToken: config.AGENT_INTERNAL_TOKEN } : {}),
    // Meter workspace-billed conversation cost back to the control plane (source "agent"). Off without the token.
    ...(config.CONTROL_PLANE_INTERNAL_TOKEN !== undefined
      ? { reportUsage: usageReporter(config.CONTROL_PLANE_URL, config.CONTROL_PLANE_INTERNAL_TOKEN) }
      : {}),
    // agent.run.* lifecycle facts → the control plane's event log (fleet observability). Same token pair.
    ...(config.CONTROL_PLANE_INTERNAL_TOKEN !== undefined
      ? { reportRunEvent: runEventReporter(config.CONTROL_PLANE_URL, config.CONTROL_PLANE_INTERNAL_TOKEN) }
      : {}),
    // Durable approvals (A6) — the park registers on the control plane so it survives our restart.
    ...(config.CONTROL_PLANE_INTERNAL_TOKEN !== undefined
      ? { approvalBridge: approvalBridge(config.CONTROL_PLANE_URL, config.CONTROL_PLANE_INTERNAL_TOKEN) }
      : {}),
    // Discussion-turn lifecycle bridge (@everdict in a comment thread) — reports the placeholder comment's
    // progress to /internal/comment-activity. Same token pair as the usage meter; off without it.
    ...(config.CONTROL_PLANE_INTERNAL_TOKEN !== undefined
      ? { commentActivity: commentActivityReporter(config.CONTROL_PLANE_URL, config.CONTROL_PLANE_INTERNAL_TOKEN) }
      : {}),
    // allowStdio (AGENT_MCP_ALLOW_STDIO): permit adopted containerized stdio MCP servers to spawn `docker run`. Off by
    // default. allowedImages (AGENT_MCP_STDIO_ALLOWED_IMAGES): optional operator image allowlist (space/comma-separated).
    toolProvider: mcpToolProvider(config.mcpUrl, codeRuntime, {
      allowStdio: config.AGENT_MCP_ALLOW_STDIO === "1" || config.AGENT_MCP_ALLOW_STDIO === "true",
      allowedImages: (config.AGENT_MCP_STDIO_ALLOWED_IMAGES ?? "").split(/[\s,]+/).filter(Boolean),
    }),
    systemPrompt: EVERDICT_AGENT_SYSTEM_PROMPT,
    // Web links for the environment block — entity deep links + the desktop download page (see buildEnvironmentSection).
    webBaseUrl: config.WEB_BASE_URL,
    ...(config.DESKTOP_DOWNLOAD_URL !== undefined ? { desktopDownloadUrl: config.DESKTOP_DOWNLOAD_URL } : {}),
    now: () => new Date().toISOString(),
    newId: () => randomUUID(),
    ...(config.AGENT_MAX_TURNS !== undefined ? { maxTurns: config.AGENT_MAX_TURNS } : {}),
    // Model tiering — only effective with resolveModelById (DB + secrets); otherwise ignored (single env model).
    ...(config.AGENT_SMALL_MODEL !== undefined ? { smallModelRef: config.AGENT_SMALL_MODEL } : {}),
    ...(config.AGENT_FALLBACK_MODEL !== undefined ? { fallbackModelRef: config.AGENT_FALLBACK_MODEL } : {}),
    ...(config.AGENT_SUBAGENT_MODEL !== undefined ? { subagentModelRef: config.AGENT_SUBAGENT_MODEL } : {}),
    ...(config.AGENT_TOOL_TIMEOUT_MS !== undefined ? { toolTimeoutMs: config.AGENT_TOOL_TIMEOUT_MS } : {}),
    ...(config.AGENT_THINKING_BUDGET !== undefined ? { thinkingBudgetTokens: config.AGENT_THINKING_BUDGET } : {}),
  });

  // Reconcile loop (agent-automation A1): pushes are best-effort, so walk the control plane's deployment-wide
  // event cursor and re-feed missed events into the activation path (durable dedup makes at-least-once safe).
  if (activationRegistry && config.CONTROL_PLANE_INTERNAL_TOKEN !== undefined) {
    const activator = (app as unknown as { agentActivator?: { onEvent: (e: ActivationEvent) => Promise<number> } })
      .agentActivator;
    if (activator) {
      startEventReconcile({
        controlPlaneUrl: config.CONTROL_PLANE_URL,
        internalToken: config.CONTROL_PLANE_INTERNAL_TOKEN,
        onEvent: (event) => activator.onEvent(event),
      });
      console.error("▶ everdict-agent: event reconcile loop on (registry-driven trigger activation)");
    }
  }

  // Prometheus scrape endpoint — registered here (process-level operator surface, like the control plane's:
  // unauthenticated by convention; deployments firewall the scrape path).
  app.get("/metrics", async (_req, reply) =>
    reply.header("content-type", "text/plain; version=0.0.4").send(metrics.render()),
  );

  await app.listen({ port: config.PORT, host: "0.0.0.0" });
  console.error(`▶ everdict-agent listening on :${config.PORT} (control plane ${config.CONTROL_PLANE_URL})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
