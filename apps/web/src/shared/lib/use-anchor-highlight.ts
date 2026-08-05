'use client'

import { useEffect } from 'react'

// A notification points at one thing INSIDE a page — the comment that mentioned you, the report artifact that
// was produced. The address carries it as a SEARCH PARAMETER (`?comment=<id>`, `?artifact=<id>`), not as a
// `#fragment`: some of our addresses normalize server-side (an issue's uuid → `ENG-12`, a cycle's uuid → its
// team's numbered address) and a redirect drops a fragment while it carries a search parameter through.
// `#<family>-<id>` is still honoured, for a link somebody copied out of the address bar by hand.
//
// The element is found by convention — `id={`${family}-${id}`}` — so a page opts in by giving its rows that id
// and calling this once.
export function useAnchorHighlight(family: string): void {
  useEffect(() => {
    const url = new URL(window.location.href)
    const queried = url.searchParams.get(family)
    const hashed = url.hash.startsWith(`#${family}-`) ? url.hash.slice(family.length + 2) : null
    const id = queried ?? hashed
    if (id === null || id.length === 0) return
    const el = document.getElementById(`${family}-${id}`)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.add('ring-2', 'ring-primary/60')
    const timer = setTimeout(() => el.classList.remove('ring-2', 'ring-primary/60'), 2400)
    return () => clearTimeout(timer)
  }, [family])
}
