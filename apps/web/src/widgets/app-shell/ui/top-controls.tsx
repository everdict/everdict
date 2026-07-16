'use client'

import { NotificationBell } from '@/widgets/notification-bell'
import { WorkSummary } from '@/widgets/work-panel'

// Floating top-right control cluster — the notification bell (1st) + the work-summary widget (2nd, collapsed).
// AppShell mounts it once. Clicking the work summary opens the docking rail (WorkRail) on the right, which takes up
// layout space (WorkRail is a sibling of main). On the desktop shell (Electron) it sits below the title bar
// (--titlebar-h) so it doesn't overlap. Caution: do NOT put transform/filter/backdrop-filter on this container —
// when an inner element goes fixed, the containing block would stop being the viewport and the mobile sheet breaks
// (hence an opaque pill with no glass effect).
export function TopControls({ workspace }: { workspace: string }) {
  return (
    <div
      style={{ top: 'calc(var(--titlebar-h) + 0.375rem)' }}
      className="fixed right-4 z-40 flex items-center gap-0.5 rounded-lg border border-border bg-card p-0.5 shadow-raise"
    >
      <NotificationBell workspace={workspace} />
      <WorkSummary />
    </div>
  )
}
