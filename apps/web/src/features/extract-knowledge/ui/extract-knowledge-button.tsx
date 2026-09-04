'use client'

import { useState, useTransition } from 'react'
import { Sparkles } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { useRefresh } from '@/shared/lib/use-refresh'
import { Button } from '@/shared/ui/button'

import { extractKnowledgeAction } from '../api/extract-knowledge'

// Mine a thread for entry candidates. An explicit act, not something the page does on open: it is a real
// billable model call, and the result is PROPOSED entries awaiting review rather than published knowledge.
export function ExtractKnowledgeButton() {
  const t = useTranslations('knowledge')
  const refresh = useRefresh()
  const [busy, start] = useTransition()
  const [message, setMessage] = useState<string>()
  const [error, setError] = useState<string>()

  return (
    <span className="inline-flex items-center gap-2">
      {error !== undefined && <span className="text-[12px] text-destructive">{error}</span>}
      {message !== undefined && <span className="text-[12px] text-muted-foreground">{message}</span>}
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        title={t('extractTitle')}
        onClick={() => {
          setError(undefined)
          setMessage(undefined)
          const text = window.prompt(t('extractPrompt'))
          // An empty prompt is a CANCEL. Sending it would spend a model call on nothing.
          if (text === null || text.trim() === '') return
          start(async () => {
            const res = await extractKnowledgeAction(text.trim())
            if (!res.ok) {
              setError(res.error ?? t('extractError'))
              return
            }
            // The COUNT is the outcome — "done" leaves a reader hunting the list for what appeared, and
            // zero candidates is a real answer worth saying out loud.
            setMessage(t('extracted', { n: res.proposed ?? 0 }))
            refresh()
          })
        }}
      >
        <Sparkles className="size-4" /> {t('extract')}
      </Button>
    </span>
  )
}
