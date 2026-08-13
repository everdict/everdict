import { shouldBypassProxy } from "@everdict/contracts";
import { Agent, Dispatcher, EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

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
    proxyRoutingDispatcher(
      new EnvHttpProxyAgent({
        ...(p.httpProxy ? { httpProxy: p.httpProxy } : {}),
        ...(p.httpsProxy ? { httpsProxy: p.httpsProxy } : {}),
        ...(p.noProxy ? { noProxy: p.noProxy } : {}),
      }),
      p.noProxy,
    ),
  );
  return {
    ...(p.httpProxy ? { httpProxy: p.httpProxy } : {}),
    ...(p.httpsProxy ? { httpsProxy: p.httpsProxy } : {}),
  };
}

// ── THE BYPASS LIST IS THE OPERATOR'S, NOT THE TRANSPORT LIBRARY'S ───────────────────────────────────
//
// `EnvHttpProxyAgent` reads NO_PROXY in its own narrow dialect: exact hostnames and dot suffixes. An
// operator who writes `10.0.0.0/8` or `192.168.` — both conventional, both what curl and every Python
// client accept — gets a file that says one thing and a process that does another, and every internal
// host is tunnelled through the corporate proxy. That is not a slower path, it is a different failure:
// a 75 KB span upload sat in the proxy for 120s and was DROPPED while small requests to the same host
// succeeded, so the export reported healthy and produced traces with no spans.
//
// So the routing decision is ours (`shouldBypassProxy`, in contracts, stated and tested) and the agent
// keeps its own list as well — the union, since either saying "bypass" sends the request direct.
// Mirror of packages/orchestrator/src/proxy-dispatcher.ts.
export function proxyRoutingDispatcher(
  proxied: Dispatcher,
  noProxy: string | undefined,
  // The non-proxied pool. Injected so a test can watch WHERE a request went, which is the only observable
  // that matters here — the bug being fixed is a request arriving at the wrong one.
  injectedDirect?: Dispatcher,
): Dispatcher {
  if (!noProxy) return proxied; // nothing to bypass → no indirection, no second connection pool
  const direct = injectedDirect ?? new Agent();
  // Only `dispatch` is overridden: it is the whole of the seam Node's fetch uses, and the two pools are
  // process-lifetime (the global dispatcher is installed at boot and never swapped), so there is no
  // close/destroy path to forward. The handler type is read off the base method rather than named, because
  // undici renamed it between minor versions and this file must compile against whichever one is resolved.
  class ProxyRouter extends Dispatcher {
    override dispatch(options: Dispatcher.DispatchOptions, handler: Parameters<Dispatcher["dispatch"]>[1]): boolean {
      const origin = typeof options.origin === "string" ? options.origin : (options.origin?.href ?? "");
      return shouldBypassProxy(origin, noProxy)
        ? direct.dispatch(options, handler)
        : proxied.dispatch(options, handler);
    }
  }
  return new ProxyRouter();
}
