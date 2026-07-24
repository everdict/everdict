import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

// Standard outbound-proxy env, read case-insensitively (both HTTP_PROXY and http_proxy are conventional). Pure — no
// side effects, so the decision (whether a proxy is configured) is unit-testable without touching global state.
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

// Install a proxy-aware GLOBAL dispatcher so EVERY outbound fetch honors HTTP(S)_PROXY / NO_PROXY behind a corporate
// proxy. The control plane's clients — the LLM transports (@everdict/llm), trace pull/export (@everdict/trace), the
// GitHub App gateway, and Mattermost — all funnel through the global `fetch`, and undici's `setGlobalDispatcher` sets
// the SAME global that Node's built-in fetch reads, so this one call covers every site with no per-client change. A
// no-op when no proxy is configured (bare fetch, today's behavior), so a non-proxied deployment is unaffected.
// EnvHttpProxyAgent applies NO_PROXY per request, so internal hosts (localhost, the control plane's own services, the
// DB-adjacent stores) bypass the proxy. Returns the installed config (or undefined) for a boot log.
//
// EnvHttpProxyAgent is marked experimental in undici 6.x (promoted to stable in newer Node); we pin undici via the
// lockfile and use it deliberately for its NO_PROXY handling — a plain ProxyAgent would wrongly route internal traffic
// through the proxy. The one-time UNDICI-EHPA boot warning is expected.
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
