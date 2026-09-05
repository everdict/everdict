'use client'

import { Sparkles } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { startProductTour } from '@/shared/lib/tour'
import { Button } from '@/shared/ui/button'

// The guide page's "take the product tour" — it tells the ProductTour mounted on the sidebar (AppShell) to re-run (a module custom event).
export function StartTourButton() {
  const t = useTranslations('guidePage')
  return (
    <Button
      variant="secondary"
      size="sm"
      // The tour points at the desktop sidebar, so it is hidden on mobile (the guide body still reads fine on mobile).
      className="hidden md:inline-flex"
      onClick={() => startProductTour()}
    >
      <Sparkles />
      {t('takeTour')}
    </Button>
  )
}
