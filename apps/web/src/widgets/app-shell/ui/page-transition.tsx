'use client'

import type { ReactNode } from 'react'
import { usePathname } from 'next/navigation'

// Replay the body as a staggered reveal (.rise) on every route change — keying by pathname remounts on page change so
// the CSS entry animation runs again (frontend-design: a well-orchestrated page-load moment). reduced-motion is disabled in globals.
export function PageTransition({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  return (
    <div key={pathname} className="rise">
      {children}
    </div>
  )
}
