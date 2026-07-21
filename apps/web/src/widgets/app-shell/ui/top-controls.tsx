'use client'

import { NotificationBell } from '@/widgets/notification-bell'

// Floating top-right control cluster — the notification bell (the work summary moved to the infra rail's vertical
// buttons). AppShell mounts it once. On the desktop shell (Electron) it sits below the title bar (--titlebar-h) so
// it doesn't overlap. Caution: do NOT put transform/filter/backdrop-filter on this container — when an inner
// element goes fixed, the containing block would stop being the viewport and the mobile sheet breaks (hence an
// opaque pill with no glass effect).
export function TopControls({ workspace }: { workspace: string }) {
  return (
    <div
      style={{ top: 'calc(var(--titlebar-h) + 0.375rem)' }}
      className="fixed right-4 z-40 flex items-center gap-0.5 rounded-lg border border-border bg-card p-0.5 shadow-raise"
    >
      <NotificationBell workspace={workspace} />
    </div>
  )
}
