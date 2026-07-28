import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

// Standard outbound-proxy env, read case-insensitively (both HTTP_PROXY and http_proxy are conventional). Pure — no
// side effects, so the decision (whether a proxy is configured) is unit-testable without touching global state.
// Mirror of apps/api/src/infrastructure/http/proxy-dispatcher.ts (each process owns its bootstrap infra — there is
// no shared adapter package both the api and the worker depend on that may carry an undici dependency).
export function proxyEnv(env: NodeJS.ProcessEnv = process.env): {
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
} {
  const pick = (upper: string, lower: string): string | undefined => {
    const v = env[upper]?.trim() || env[lower]?.trim();
    return v ? v : undefined;
  };
  const httpProxy = pick("HTTP_PROXY", "http_proxy");
  const httpsProxy = pick("HTTPS_PROXY", "https_proxy");
  const noProxy = pick("NO_PROXY", "no_proxy");
  return {
    ...(httpProxy ? { httpProxy } : {}),
    ...(httpsProxy ? { httpsProxy } : {}),
    ...(noProxy ? { noProxy } : {}),
  };
}

// Install a proxy-aware GLOBAL dispatcher so the worker's outbound fetches honor HTTP(S)_PROXY / NO_PROXY behind a
// corporate proxy. In this process that covers the activities' EXTERNAL calls — trace pull from a tenant's
// observability platform (LangSmith/Langfuse cloud, an off-network MLflow) and tenant-registered cluster APIs
// (buildRuntimeBackend). The internal API bridge is NOT rerouted: it passes its own per-request undici Agent
// (headers-timeout budget), which overrides the global dispatcher; Temporal gRPC rides the Rust core, not fetch —
// both are internal targets that belong in NO_PROXY anyway. A no-op when no proxy is configured.
export function installProxyDispatcher(
  env: NodeJS.ProcessEnv = process.env,
): { httpProxy?: string; httpsProxy?: string } | undefined {
  const p = proxyEnv(env);
  if (!p.httpProxy && !p.httpsProxy) return undefined; // no proxy configured → leave the default dispatcher in place
  setGlobalDispatcher(
    new EnvHttpProxyAgent({
      ...(p.httpProxy ? { httpProxy: p.httpProxy } : {}),
      ...(p.httpsProxy ? { httpsProxy: p.httpsProxy } : {}),
      ...(p.noProxy ? { noProxy: p.noProxy } : {}),
    }),
  );
  return {
    ...(p.httpProxy ? { httpProxy: p.httpProxy } : {}),
    ...(p.httpsProxy ? { httpsProxy: p.httpsProxy } : {}),
  };
}
