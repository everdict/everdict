import { Agent, Dispatcher, EnvHttpProxyAgent, setGlobalDispatcher } from 'undici'

import { shouldBypassProxy } from './no-proxy'

// Standard outbound-proxy env, read case-insensitively (both HTTP_PROXY and http_proxy are conventional).
// Pure — the "is a proxy configured" decision is testable without global state. A reinterpretation of
// apps/api's infrastructure/http/proxy-dispatcher for the web tier, which cannot import @everdict/* at
// runtime (type-only contracts rule) — the matcher is the drift-guarded local mirror in ./no-proxy.
//
// NO_PROXY is the UNION of both spellings, not a pick: compose merges the internal service list into
// `no_proxy` while a host shell exports `NO_PROXY`, and the two routinely carry entries the other lacks —
// picking one silently dropped half the bypass list (downstream report 4.1).
export function proxyEnv(env: NodeJS.ProcessEnv = process.env): {
  httpProxy?: string
  httpsProxy?: string
  noProxy?: string
} {
  const pick = (upper: string, lower: string): string | undefined => {
    const v = env[upper]?.trim() || env[lower]?.trim()
    return v ? v : undefined
  }
  const httpProxy = pick('HTTP_PROXY', 'http_proxy')
  const httpsProxy = pick('HTTPS_PROXY', 'https_proxy')
  const noProxyParts = [env.NO_PROXY?.trim(), env.no_proxy?.trim()].filter((v): v is string =>
    Boolean(v)
  )
  const noProxy = noProxyParts.length > 0 ? noProxyParts.join(',') : undefined
  return {
    ...(httpProxy ? { httpProxy } : {}),
    ...(httpsProxy ? { httpsProxy } : {}),
    ...(noProxy ? { noProxy } : {}),
  }
}

// The bypass list is the operator's, not the transport library's: EnvHttpProxyAgent honours exact hostnames
// and dot suffixes only, while operators also write CIDR (`10.0.0.0/8`) and bare prefixes (`192.168.`) —
// silently ignored, so internal traffic tunnelled through the corporate proxy. The routing decision is OURS
// (the mirrored matcher), the agent keeps its own narrower list too — the union, since either saying
// "bypass" sends the request direct. Same shape as apps/api's proxyRoutingDispatcher.
export function proxyRoutingDispatcher(
  proxied: Dispatcher,
  noProxy: string | undefined,
  injectedDirect?: Dispatcher
): Dispatcher {
  if (!noProxy) return proxied
  const direct = injectedDirect ?? new Agent()
  class ProxyRouter extends Dispatcher {
    override dispatch(
      options: Dispatcher.DispatchOptions,
      handler: Parameters<Dispatcher['dispatch']>[1]
    ): boolean {
      const origin =
        typeof options.origin === 'string' ? options.origin : (options.origin?.href ?? '')
      return shouldBypassProxy(origin, noProxy)
        ? direct.dispatch(options, handler)
        : proxied.dispatch(options, handler)
    }
  }
  return new ProxyRouter()
}

// Install a proxy-aware global dispatcher — behind a corporate proxy the web server's outbound fetches
// (e.g. the desktop release-list call to api.github.com) ride HTTP(S)_PROXY. undici's setGlobalDispatcher
// sets the same global Node's built-in fetch reads, so this one boot-time call covers every call site.
// No proxy configured → no-op (unproxied deployments unchanged). Returns the installed config for the boot log.
export function installProxyDispatcher(
  env: NodeJS.ProcessEnv = process.env
): { httpProxy?: string; httpsProxy?: string } | undefined {
  const p = proxyEnv(env)
  if (!p.httpProxy && !p.httpsProxy) return undefined
  setGlobalDispatcher(
    proxyRoutingDispatcher(
      new EnvHttpProxyAgent({
        ...(p.httpProxy ? { httpProxy: p.httpProxy } : {}),
        ...(p.httpsProxy ? { httpsProxy: p.httpsProxy } : {}),
        ...(p.noProxy ? { noProxy: p.noProxy } : {}),
      }),
      p.noProxy
    )
  )
  return {
    ...(p.httpProxy ? { httpProxy: p.httpProxy } : {}),
    ...(p.httpsProxy ? { httpsProxy: p.httpsProxy } : {}),
  }
}
