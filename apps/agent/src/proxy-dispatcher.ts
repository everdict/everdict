import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

// Standard outbound-proxy env, read case-insensitively (both HTTP_PROXY and http_proxy are conventional). Pure — no
// side effects, so the decision (whether a proxy is configured) is unit-testable without touching global state.
// Mirror of apps/api/src/infrastructure/http/proxy-dispatcher.ts (apps do not import each other; each process owns
// its bootstrap infra).
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

// Install a proxy-aware GLOBAL dispatcher so the agent's outbound fetches honor HTTP(S)_PROXY / NO_PROXY behind a
// corporate proxy. In this process that covers the LLM provider transports (@everdict/llm rides the global fetch),
// web search, and the GitHub/Mattermost integration actions. undici's setGlobalDispatcher sets the SAME global that
// Node's built-in fetch reads, so this one call covers every site with no per-client change. A no-op when no proxy
// is configured. EnvHttpProxyAgent applies NO_PROXY per request, so internal targets (the control plane, Postgres-
// adjacent stores) bypass the proxy when listed there — the compose stacks append service names automatically.
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
