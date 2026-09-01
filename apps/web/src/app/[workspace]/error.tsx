'use client'

import { useEffect } from 'react'
import { useTranslations } from 'next-intl'

import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'

// The error boundary for every screen under a workspace — the counterpart to `loading.tsx` beside it.
//
// There was none anywhere in the app, and on a `force-dynamic` route that is not a cosmetic gap: every page
// is a server render over live control-plane reads, so one upstream hiccup threw past the segment and the
// user got the framework's blank screen with no way back except the browser's reload — losing whatever
// filter, scroll and dialog state the screen held. A boundary here turns the same failure into a sentence
// and a retry that re-renders only this segment.
//
// Scoped to `[workspace]` for the same reason the loading boundary is: it is the shallowest place that owns
// the shell, so the sidebar and the workspace chrome survive the failure instead of disappearing with it. A
// screen that wants a more specific recovery puts its own `error.tsx` in its segment.
export default function WorkspaceError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const t = useTranslations('ui')

  // Server-thrown messages are digested in production, so the console is where an operator finds the shape of
  // what failed. Logged rather than rendered: an upstream error string is not a sentence for a user.
  useEffect(() => {
    console.error('[workspace] segment error', error)
  }, [error])

  return (
    <div className="mx-auto max-w-2xl px-4 py-16">
      <Callout tone="danger">{t('screenErrorBody')}</Callout>
      <div className="mt-4 flex items-center gap-3">
        <Button onClick={() => reset()} type="button">
          {t('retry')}
        </Button>
        {error.digest !== undefined && (
          <span className="text-[12px] text-faint">{t('errorDigest', { digest: error.digest })}</span>
        )}
      </div>
    </div>
  )
}
