'use client'

import { useEffect, type ReactNode } from 'react'
import { usePathname } from 'next/navigation'

// Chrome-less shell for pages rendered INSIDE the infra panel's iframe (the [workspace] layout switches to this
// when the document was requested as an iframe — sec-fetch-dest). The real routed pages render at full fidelity
// with their own in-iframe navigation; only the app chrome (sidebar · rail · top controls) is dropped.
//
// Axis escape: the split view is eval-left / infra-right. Links to infra segments stay inside the iframe
// (independent right-side navigation); any other in-app link (scorecards, datasets, settings, overview …) is an
// eval-axis hop, so it is forwarded to the parent window to navigate the LEFT half instead.

const INFRA_SEGMENTS = new Set(['runs', 'runtimes', 'schedules'])

export function EmbedShell({ children }: { children: ReactNode }) {
  const pathname = usePathname()

  // Bounce guard — if a NON-infra page ends up inside the panel's iframe anyway (a pre-hydration click beats
  // the interceptor below, a redirect, a programmatic push, …), forward it to the parent so the LEFT half
  // shows the real page (e.g. the sidebar's desktop-download page) and let the panel reset this iframe.
  useEffect(() => {
    const segment = pathname.split('/')[2] ?? ''
    if (window.self === window.top || INFRA_SEGMENTS.has(segment)) return
    const url = new URL(window.location.href)
    url.searchParams.delete('embed')
    window.parent.postMessage(
      { type: 'everdict:left-nav', href: url.pathname + url.search, bounce: true },
      window.location.origin
    )
  }, [pathname])

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
        return
      const target = e.target as HTMLElement | null
      const anchor = target?.closest?.('a[href^="/"]')
      const href = anchor?.getAttribute('href')
      if (!href) return
      // href = /{workspace}/{segment}/… — infra segments navigate in place, everything else escapes left.
      const segment = href.split('/')[2] ?? ''
      if (INFRA_SEGMENTS.has(segment)) return
      e.preventDefault()
      e.stopPropagation()
      window.parent.postMessage({ type: 'everdict:left-nav', href }, window.location.origin)
    }
    // Capture phase — runs before the Next Link handler, so preventDefault stops the in-iframe router.
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [])

  return (
    <main className="min-h-screen">
      <div className="mx-auto w-full max-w-[1180px] px-4 pb-6 pt-4 text-[13px] sm:px-5">
        {children}
      </div>
    </main>
  )
}
