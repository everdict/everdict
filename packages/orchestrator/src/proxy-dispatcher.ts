import { shouldBypassProxy } from "@everdict/contracts";
import { Agent, Dispatcher, EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

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
  // NO_PROXY is the UNION of both spellings, not a pick: compose merges the internal service list into
  // `no_proxy` while a host shell exports `NO_PROXY` — the two routinely carry entries the other lacks,
  // and picking one silently dropped half the bypass list (downstream report 4.1).
  const noProxyParts = [env.NO_PROXY?.trim(), env.no_proxy?.trim()].filter((v): v is string => Boolean(v));
  const noProxy = noProxyParts.length > 0 ? noProxyParts.join(",") : undefined;
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
// Mirror of apps/api/src/infrastructure/http/proxy-dispatcher.ts.
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
