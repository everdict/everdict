'use client'

import { useState, useTransition } from 'react'
import { ExternalLink, GitPullRequest } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { Button } from '@/shared/ui/button'

import { openSetupPrAction } from '../api/manage-ci-links'

// Open setup PR — PRs the link's workflow YAML into the target repo (workspace GitHub App token). On success, opens the PR in a new tab.
// If the App isn't installed on that repo, the control plane returns 404 → surfaced via onError.
export function SetupPrButton({
  repository,
  host,
  size = 'xs',
  variant = 'secondary',
  onError,
}: {
  repository: string
  host?: string // GHE base URL — unset = github.com link
  size?: 'xs' | 'sm'
  variant?: 'secondary' | 'outline'
  onError?: (message: string) => void
}) {
  const t = useTranslations('manageCiLinks')
  const [pending, startTransition] = useTransition()
  const [opened, setOpened] = useState<string>() // the PR url just opened

  function onClick() {
    startTransition(async () => {
      const r = await openSetupPrAction(repository, host)
      if (r.ok && r.prUrl) {
        setOpened(r.prUrl)
        window.open(r.prUrl, '_blank', 'noopener,noreferrer')
      } else onError?.(r.error ?? t('setupPrFailed'))
    })
  }

  if (opened) {
    return (
      <a
        href={opened}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-[12px] font-[510] text-link transition-colors hover:text-foreground"
      >
        <ExternalLink className="size-3.5" />
        {t('viewOpenedPr')}
      </a>
    )
  }

  return (
    <Button size={size} variant={variant} disabled={pending} onClick={onClick}>
      <GitPullRequest />
      {pending ? t('opening') : t('setupPr')}
    </Button>
  )
}
