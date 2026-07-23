import type { ReactNode } from 'react'

// One shared settings column. Every settings tab — form/account (General · Profile · Preferences · API keys ·
// Personal secrets) AND data-dense (Members · Secrets · Models · Integrations · Observability · CI · Runners ·
// Budget) — renders inside this single centered max-width, so the content's left/right edges never shift when
// switching tabs (user decision — replaces the former two-tier SettingsColumn/full-width split). ~1024px keeps
// label→control form rows readable while leaving roster/list pages room to breathe. See docs/web.md.
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-5xl">{children}</div>
}
