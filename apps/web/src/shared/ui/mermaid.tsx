'use client'

import { useEffect, useState } from 'react'

// mermaid.render requires a temporary DOM id — React's useId mixes in characters a CSS selector cannot take, so a global counter is used.
let renderSeq = 0

// The viewer that renders a ```mermaid fence's source as an SVG diagram. The library is a dynamic import (its own chunk), so it loads only when a
// diagram actually reaches the screen. The theme follows light/dark by observing html.dark (re-rendering on a toggle), and a parse failure
// (a syntax error, or a fence still streaming) falls back QUIETLY to the raw code block. The SVG is injected with dangerouslySetInnerHTML, but it
// is mermaid's own output with labels sanitized at securityLevel 'strict' (the default) rather than source HTML.
export function MermaidDiagram({ chart }: { chart: string }) {
  const [svg, setSvg] = useState('')
  const [failed, setFailed] = useState(false)
  const [dark, setDark] = useState(false)

  // The parent app's theme authority is the single html.dark class — that alone is observed (never computing prefers-color-scheme ourselves).
  useEffect(() => {
    const el = document.documentElement
    const sync = () => setDark(el.classList.contains('dark'))
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(el, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const { default: mermaid } = await import('mermaid')
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: dark ? 'dark' : 'default',
        })
        // `render` can leave a temporary element behind on failure, so `parse` validates first (parsing only, no DOM side effects).
        await mermaid.parse(chart)
        const { svg: rendered } = await mermaid.render(`everdict-mermaid-${renderSeq++}`, chart)
        if (!cancelled) {
          setSvg(rendered)
          setFailed(false)
        }
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [chart, dark])

  // Loading or failed = the raw code block (a fence's default presentation) — replaced by the diagram only on a successful render.
  // data-mermaid is attached in BOTH states: "this fence went to a diagram" has to be visible from the server output alone, so that whether the
  // render succeeded (which differs only in the browser) and whether it is wired (which differs here) can be checked separately.
  if (failed || svg === '') {
    return (
      <pre
        data-mermaid=""
        className="overflow-x-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-[12px] leading-relaxed text-foreground"
      >
        <code>{chart}</code>
      </pre>
    )
  }
  return (
    <div
      data-mermaid=""
      className="overflow-x-auto rounded-md border border-border bg-muted/20 p-3 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
