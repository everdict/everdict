// The Next instrumentation hook — it runs ONCE at server start (before any request is handled). On a deployment behind a corporate proxy it
// installs the global dispatcher so server-side outbound fetch respects HTTP(S)_PROXY / NO_PROXY (the web extension of the same first-class handling apps/api has).
// `register` is called on the edge runtime (middleware) too, so it is a DYNAMIC import under the nodejs runtime only — keeping undici out of the edge bundle.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { installProxyDispatcher } = await import('./shared/lib/proxy-dispatcher')
    const proxy = installProxyDispatcher()
    if (proxy)
      // eslint-disable-next-line no-console -- a once-per-boot operational log: for confirming downstream whether the proxy was applied
      console.log(
        `[everdict-web] outbound proxy: ${proxy.httpsProxy ?? proxy.httpProxy} (NO_PROXY honored)`
      )
  }
}
