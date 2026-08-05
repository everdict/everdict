'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

import { useRefresh } from '@/shared/lib/use-refresh'

// While in a non-terminal state (queued/running), periodically re-run the server component (router.refresh) to update the "progress" live.
// router.refresh re-fetches on the server, so it honors the no-direct-browser→control-plane-call rule. No render output.
export function AutoRefresh({
  enabled,
  intervalMs = 2500,
}: {
  enabled: boolean
  intervalMs?: number
}) {
  const router = useRouter()
  const refresh = useRefresh()
  useEffect(() => {
    if (!enabled) return
    const t = setInterval(() => refresh(), intervalMs)
    return () => clearInterval(t)
  }, [enabled, intervalMs, router])
  return null
}
