'use client'

import { FlaskConical } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { Button } from '@/shared/ui/button'

import { useOpenPlayground } from '../model/infra-panel-context'

// "Test in playground" — from a harness detail page, open the infra panel's playground tab with THIS harness
// (and the version being viewed) prefilled into the boot form. Deliberately a prefill, not a boot: a session
// spends a container, so the member still presses boot. The framed/direct dispatch lives in useOpenPlayground,
// so this works both on the left shell and inside an infra iframe.
export function OpenPlaygroundButton({
  harnessId,
  version,
}: {
  harnessId: string
  version?: string
}) {
  const t = useTranslations('playground')
  const openPlayground = useOpenPlayground()

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => openPlayground({ harnessId, ...(version ? { version } : {}) })}
    >
      <FlaskConical />
      {t('openFromHarness')}
    </Button>
  )
}
