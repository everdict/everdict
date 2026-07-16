import type { ReactNode } from 'react'

import { cn } from '@/shared/lib/utils'

// Centered readable column for settings FORM/account pages (General · Profile · Preferences · API keys · Personal secrets).
// Keeps the label→control settings-list rows readable and the page balanced (no dead right half on wide screens),
// replacing the ad-hoc, left-hugging `max-w-2xl` these pages used to carry inline.
// Data-dense settings pages (Members · Secrets · Models · Integrations · Observability · CI · Runners · Budget) intentionally
// skip this and fill the full content width — so a form is a calm centered column while a roster/list uses the whole screen.
// One shared wrapper = uniform width discipline across the settings area (see docs/web.md settings conventions).
export function SettingsColumn({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return <div className={cn('mx-auto w-full max-w-3xl space-y-6', className)}>{children}</div>
}
